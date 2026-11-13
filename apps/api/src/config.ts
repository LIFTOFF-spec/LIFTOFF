import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  ANTI_COPYCAT_CONFIG,
  assertGraduatedRouteAllowed,
  FEE_CONFIG,
  LAUNCH_DEPOSIT,
  LAUNCH_LIMITS,
  platformFor,
  solanaAddressSchema,
  solPriceSettingsFrom,
  TRADE_CONFIG,
  WALLET_REQUIREMENTS,
  type AntiCopycatConfig,
  type GraduatedRoute,
  type LaunchDepositConfig,
  type LaunchLimitsConfig,
  type SolanaCluster,
  type SolPriceSettings,
  type WalletRequirementsConfig,
} from "@liftoff/shared";
import { resolveCluster, rpcUrlFor } from "@liftoff/solana";

export interface XOAuthConfig {
  clientId: string;
  clientSecret: string;
  callbackUrl: string;
}

export interface ApiConfig {
  cluster: SolanaCluster;
  production: boolean;
  webOrigin: string;
  /** URL publik API (absolut), untuk URI metadata token on-chain. */
  publicApiUrl: string;
  /** Rahasia penanda cookie sesi. Jika kosong di development, dibuat acak per proses. */
  sessionSecret: string;
  /** Tautan X opsional. null → tidak ada OAuth X; lihat devXLinkEnabled. */
  xOAuth: XOAuthConfig | null;
  /** Tautan X development tanpa OAuth (ditandai jelas di UI), hanya di luar production. */
  devXLinkEnabled: boolean;
  rpcUrl: string;
  /** F8: RPC cadangan (RPC_BACKUP_URL) untuk failover baca. Bisa memuat API key: jangan di-log. */
  rpcBackupUrl: string | null;
  signerUrl: string | null;
  jupiterApiUrl: string;
  solPrice: SolPriceSettings;
  uploadDir: string;
  antiCopycat: AntiCopycatConfig;
  launchLimits: LaunchLimitsConfig;
  walletRequirements: WalletRequirementsConfig;
  launchDeposit: LaunchDepositConfig;
  /**
   * Header IP klien dipercaya hanya jika API berada di belakang proxy yang kita kendalikan.
   * TRUST_PROXY=1: hanya peer loopback/jaringan privat (Caddy di jaringan Docker) yang dipercaya;
   * Fastify memakai entri X-Forwarded-For paling kanan yang bukan alamat privat, yaitu IP yang
   * ditulis Caddy (`{client_ip}`; di belakang Cloudflare: CF-Connecting-IP). Entri kiri yang
   * dikirim klien tidak dipakai. Nilai lain = daftar IP/CIDR proxy (format proxy-addr).
   */
  trustProxy: false | string;
  /** Rute trade sesudah graduate (Tahap 5): cpmm di devnet, jupiter hanya mainnet. */
  tradeGraduatedRoute: GraduatedRoute;
  /** Wallet LIFTOFF penerima referral (share fee). null = tanpa referral (default: FEE_CONFIG 0). */
  tradeReferralWallet: string | null;
  /**
   * Allowlist wallet admin (ADMIN_WALLETS, dipisah koma): login SIWS dengan wallet ini membuka
   * panel peninjauan banding anti-copycat (Spec §7). Kosong = panel admin mati.
   */
  adminWallets: string[];
}

/** Proxy yang dipercaya: Caddy selalu di jaringan Docker privat (bukan hop-count: Fastify menolaknya). */
const TRUSTED_PRIVATE_PROXIES = "loopback,uniquelocal";

function trustProxyFrom(value: string | undefined): false | string {
  const v = value?.trim() ?? "";
  if (v === "" || v === "0") return false;
  return v === "1" ? TRUSTED_PRIVATE_PROXIES : v;
}

function int(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) throw new Error(`env bukan bilangan bulat >= 0: ${value}`);
  return n;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  const production = env.NODE_ENV === "production";
  const cluster = resolveCluster(env);

  const clientId = env.X_CLIENT_ID?.trim() ?? "";
  const clientSecret = env.X_CLIENT_SECRET?.trim() ?? "";
  const xOAuth =
    clientId && clientSecret
      ? {
          clientId,
          clientSecret,
          callbackUrl: env.X_CALLBACK_URL?.trim() || "http://localhost:4000/api/auth/x/callback",
        }
      : null;

  let sessionSecret = env.SESSION_SECRET?.trim() ?? "";
  if (!sessionSecret) {
    if (production) throw new Error("SESSION_SECRET wajib di production");
    sessionSecret = randomBytes(32).toString("hex");
  }

  const policy = env.EXTERNAL_TICKER_UNAVAILABLE_POLICY?.trim();
  if (policy && policy !== "reject" && policy !== "allow_with_warning") {
    throw new Error("EXTERNAL_TICKER_UNAVAILABLE_POLICY harus reject | allow_with_warning");
  }

  const tradeGraduatedRoute = (env.TRADE_GRADUATED_ROUTE?.trim() ||
    TRADE_CONFIG.graduatedRoute) as GraduatedRoute;
  if (tradeGraduatedRoute !== "cpmm" && tradeGraduatedRoute !== "jupiter") {
    throw new Error("TRADE_GRADUATED_ROUTE harus cpmm | jupiter");
  }
  assertGraduatedRouteAllowed(tradeGraduatedRoute, cluster);
  const referral = env.TRADE_REFERRAL_WALLET?.trim() ?? "";
  if (referral && referral !== "off" && !solanaAddressSchema.safeParse(referral).success) {
    throw new Error("TRADE_REFERRAL_WALLET bukan alamat Solana yang valid");
  }

  const adminWallets = (env.ADMIN_WALLETS ?? "")
    .split(",")
    .map((w) => w.trim())
    .filter(Boolean);
  for (const w of adminWallets) {
    if (!solanaAddressSchema.safeParse(w).success) {
      throw new Error(`ADMIN_WALLETS berisi alamat yang tidak valid: ${w}`);
    }
  }

  return {
    cluster,
    production,
    adminWallets,
    webOrigin: env.WEB_ORIGIN?.trim() || "http://localhost:3000",
    publicApiUrl: (env.PUBLIC_API_URL?.trim() || "http://localhost:4000").replace(/\/$/, ""),
    sessionSecret,
    xOAuth,
    // Dev-link X tidak pernah aktif di production, dan otomatis mati begitu OAuth X dikonfigurasi.
    devXLinkEnabled: !production && xOAuth === null && env.DEV_X_LINK !== "0",
    rpcUrl: rpcUrlFor(cluster, env.RPC_URL),
    rpcBackupUrl: env.RPC_BACKUP_URL?.trim() || null,
    signerUrl: env.SIGNER_URL?.trim() || null,
    jupiterApiUrl: env.JUPITER_API_URL?.trim() || "https://lite-api.jup.ag",
    solPrice: solPriceSettingsFrom(env),
    // Default: <repo>/.data/uploads (gitignored). Produksi: object storage (Tahap 9).
    uploadDir:
      env.UPLOAD_DIR?.trim() || fileURLToPath(new URL("../../../.data/uploads", import.meta.url)),
    antiCopycat: {
      imageHashMaxDistance: int(
        env.IMAGE_HASH_MAX_DISTANCE,
        ANTI_COPYCAT_CONFIG.imageHashMaxDistance,
      ),
      externalMinLiquidityUsd: int(
        env.EXTERNAL_TICKER_MIN_LIQUIDITY_USD,
        ANTI_COPYCAT_CONFIG.externalMinLiquidityUsd,
      ),
      externalLookupTimeoutMs: int(
        env.EXTERNAL_TICKER_TIMEOUT_MS,
        ANTI_COPYCAT_CONFIG.externalLookupTimeoutMs,
      ),
      externalUnavailablePolicy:
        (policy as AntiCopycatConfig["externalUnavailablePolicy"] | undefined) ??
        ANTI_COPYCAT_CONFIG.externalUnavailablePolicy,
      nameSimilarityThreshold: ANTI_COPYCAT_CONFIG.nameSimilarityThreshold,
      riskWeights: ANTI_COPYCAT_CONFIG.riskWeights,
      highRiskScore: int(env.ANTI_COPYCAT_HIGH_RISK_SCORE, ANTI_COPYCAT_CONFIG.highRiskScore),
    },
    launchLimits: {
      globalPerDay: int(env.LAUNCH_LIMIT_GLOBAL_PER_DAY, LAUNCH_LIMITS.globalPerDay),
      perWalletPer24h: int(env.LAUNCH_LIMIT_PER_WALLET_PER_24H, LAUNCH_LIMITS.perWalletPer24h),
      perWalletWithXPer24h: int(
        env.LAUNCH_LIMIT_PER_WALLET_WITH_X_PER_24H,
        LAUNCH_LIMITS.perWalletWithXPer24h,
      ),
    },
    walletRequirements: {
      minBalanceLamports: int(
        env.WALLET_MIN_BALANCE_LAMPORTS,
        WALLET_REQUIREMENTS.minBalanceLamports,
      ),
      minAgeDays: int(env.WALLET_MIN_AGE_DAYS, WALLET_REQUIREMENTS.minAgeDays),
    },
    launchDeposit: {
      // Default dari config bersama (aktif): biaya launch dibayar creator. "0" mematikan.
      enabled: env.LAUNCH_DEPOSIT_ENABLED
        ? env.LAUNCH_DEPOSIT_ENABLED === "1"
        : LAUNCH_DEPOSIT.enabled,
      lamports: int(env.LAUNCH_DEPOSIT_LAMPORTS, LAUNCH_DEPOSIT.lamports),
    },
    trustProxy: trustProxyFrom(env.TRUST_PROXY),
    tradeGraduatedRoute,
    // Referral hanya aktif jika FEE_CONFIG.referralFeeBps > 0 (saat ini 0 = dimatikan pemilik).
    tradeReferralWallet:
      referral === "off" || FEE_CONFIG.referralFeeBps === 0
        ? null
        : referral || platformFor(cluster, env).masterWallet,
  };
}

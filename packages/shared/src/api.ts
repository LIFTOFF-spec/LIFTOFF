/**
 * Bentuk response API LIFTOFF (Tahap 3).
 *
 * Dipakai bersama oleh mock frontend (Tahap 2, `apps/web/lib/mock/`) dan
 * `apps/api`, sehingga mock cukup ditukar dengan fetch ke API sungguhan.
 * Semua nominal adalah string desimal (bukan float) agar tidak kehilangan presisi.
 */

/** Status setiap angka ekonomi (Aturan #4). */
export const STAT_STATUSES = ["verified", "estimated", "delayed", "unavailable"] as const;
export type StatStatus = (typeof STAT_STATUSES)[number];

/**
 * Asal data. `mock` wajib tampil dengan badge MOCK (Aturan #3). `price_feed` = setara USD dari harga
 * SOL/USD terverifikasi (mainnet), selalu estimasi dan tampil dengan tanda "≈".
 */
export type DataSource = "mock" | "onchain" | "indexer" | "price_feed";

/** Satu angka beserta status & waktu update-nya. */
export interface Stat {
  /** String desimal; `null` jika `unavailable`. */
  value: string | null;
  /** Satuan, mis. "USD", "SOL", "%", "holders", atau ticker token. */
  unit: string;
  status: StatStatus;
  /** ISO 8601; `null` jika belum pernah diperbarui. */
  updatedAt: string | null;
  source: DataSource;
}

/** Envelope standar semua response GET. */
export interface ApiResponse<T> {
  data: T;
  meta: { source: DataSource; generatedAt: string };
}

// ---------------------------------------------------------------- harga SOL/USD

/** GET /api/price/sol. `assumed` = devnet (harga asumsi berlabel MOCK, bukan harga pasar). */
export interface SolPriceStatus {
  status: "verified" | "unverified" | "assumed";
  /** null kecuali `verified`. */
  usd: string | null;
  observedAt: string | null;
  ageSeconds: number | null;
  maxAgeSeconds: number;
  deviationBps: number | null;
  maxDeviationBps: number;
  /** Kode alasan, mis. `jupiter_unreadable`. Tanpa pesan error mentah. */
  issues: string[];
}

// ---------------------------------------------------------------- pairs

/** GET /api/pairs — dimuat dinamis lewat StonkFunAdapter (Spec §6). */
export interface Pair {
  /** ID stabil pair (satu quote mint bisa punya lebih dari satu global config). */
  id: string;
  symbol: string;
  name: string;
  mint: string;
  decimals: number;
  /** Boleh dipilih untuk launch sekarang (= launchable && launchLabReady). */
  supported: boolean;
  /** Config StonkFun ada untuk pair ini. */
  launchable: boolean;
  /** Config kompatibel dengan alur LaunchLab LIFTOFF. */
  launchLabReady: boolean;
  /** Alasan tidak bisa dipilih (ditampilkan di form). */
  unavailableReason: string | null;
  /** Saham tokenized (SPYx, NVDAx, …). */
  tokenized: boolean;
  /** Market cap saat start, dalam unit pair (perkiraan dari harga acuan). null = tanpa harga. */
  curveStart: string | null;
  /** Raise graduation dalam unit pair, dari StonkFunAdapter. null = belum dibaca (mainnet: GET /api/pairs/:id). */
  curveGraduation: string | null;
  /** Target setara USD yang sama untuk semua pair (P3). null = tanpa harga (mainnet). */
  curveStartUsd: string | null;
  curveGraduationUsd: string | null;
  /** Global config LaunchLab (Tahap 1). */
  configId: string;
  /** LIFTOFF bisa menerima referral fee di pair ini. */
  referralSupported: boolean;
  note: string | null;
  /** Kategori StonkFun (`custom`, `xstock`, …); null = tidak dilaporkan (devnet). */
  category: string | null;
  categoryLabel: string | null;
  logoUrl: string | null;
  /** Simbol ini dipakai lebih dari satu mint: tampilkan mint agar tidak tertukar. */
  symbolAmbiguous: boolean;
  /** Peringatan yang wajib terlihat sebelum konfirmasi. */
  warnings: string[];
}

/** GET /api/pairs/:id — pair terpilih dengan config, raise, dan pemeriksaan mint on-chain. */
export interface PairDetail extends Pair {
  /** Harga USD quote terverifikasi; null = tidak terverifikasi (tampil n/a). */
  quoteUsd: string | null;
}

/** GET /api/pairs/used — quote yang dipakai token live (filter pair). */
export interface UsedPair {
  id: string;
  symbol: string;
  name: string;
  mint: string;
}

/** GET /api/pairs/summary — ringkas untuk halaman selain Create. */
export interface PairSummaryResponse {
  total: number;
  available: number;
  categories: Array<{ category: string; label: string; total: number; available: number }>;
  unavailable: Array<{ symbol: string; reason: string }>;
  source: "devnet_emulation" | "stonkfun_mainnet";
  fetchedAt: string;
}

/** GET /api/pairs (envelope `data`) */
export interface PairListResponse {
  pairs: Pair[];
  /** Aset Spec §6 yang tidak tersedia di cluster ini, beserta alasannya. */
  unavailable: Array<{ symbol: string; reason: string }>;
  /** `devnet_emulation` = StonkFun diemulasikan oleh Platform PDA LIFTOFF (devnet). */
  source: "devnet_emulation" | "stonkfun_mainnet";
  fetchedAt: string;
}

/** GET /api/stonkfun — config aktif & ketergantungan infrastruktur (Rule 10). */
export interface StonkFunInfo {
  source: "devnet_emulation" | "stonkfun_mainnet";
  active: boolean;
  platformId: string;
  launchlabProgram: string;
  /** Platform fee curve (bps): milik StonkFun, bukan pendapatan LIFTOFF. */
  platformFeeBps: number;
  /** Creator fee curve (bps) → master wallet → 80/20. */
  creatorFeeBps: number;
  /** Creator fee pool CPMM sesudah graduate (bps) → master wallet → 80/20. */
  cpmmCreatorFeeBps: number;
  /** Nilai FEE_CONFIG; berbeda dari on-chain → UI wajib mengungkapkannya. */
  configured: { platformFeeBps: number; creatorFeeBps: number; cpmmCreatorFeeBps: number };
  creatorFeeRecipient: string;
  split: { buybackBurnBps: number; convictionReserveBps: number };
  fetchedAt: string;
}

// ---------------------------------------------------------------- tokens

export const LAUNCH_STATUSES = [
  "validating",
  "queued",
  "submitting",
  "confirming",
  "live",
  "failed",
  "needs_reconciliation",
] as const;
export type LaunchStatus = (typeof LAUNCH_STATUSES)[number];

export const DISCOVERY_FILTERS = [
  "new",
  "trending",
  "graduating",
  "graduated",
  "top-burns",
  "top-reserves",
  "reinforced",
] as const;
export type DiscoveryFilter = (typeof DISCOVERY_FILTERS)[number];

/** accumulating = belum graduate / pool belum terverifikasi (reserve disimpan, tidak disentuh). */
export const RESERVE_MODES = ["accumulating", "deploying_liquidity"] as const;
export type ReserveMode = (typeof RESERVE_MODES)[number];

export interface TokenLinks {
  website: string | null;
  telegram: string | null;
  x: string | null;
}

/** Item di GET /api/tokens */
export interface TokenSummary {
  id: string;
  /** `null` sampai launch `live` (P5: mint tidak dipublikasikan sebelum mendarat). */
  mint: string | null;
  name: string;
  ticker: string;
  imageUrl: string | null;
  quoteSymbol: string;
  quoteMint: string;
  /** null = quote belum dikenal (angka native tampil tidak tersedia, bukan ditebak). */
  quoteDecimals: number | null;
  /** Wallet kreator (identitas utama, SIWS). */
  creatorWallet: string;
  /** Akun X yang ditautkan saat launch (opsional); `null` jika tidak ada. */
  creatorXHandle: string | null;
  /** Diluncurkan dengan akun X tertaut → badge "verified creator". */
  verifiedCreator: boolean;
  launchStatus: LaunchStatus;
  createdAt: string;
  graduated: boolean;
  graduatedAt: string | null;
  /** Reserve sudah pernah dideploy ke pool (kategori "Liquidity Reinforced"). */
  liquidityReinforced: boolean;
  reserveMode: ReserveMode;
  /** Status graduation dari worker graduation (Spec §14). */
  graduationState: GraduationState;
  /** Harga spot dalam quote pair (indexer, on-chain). */
  priceQuote: Stat;
  /** Harga × supply mint on-chain, dalam quote pair. */
  marketCapQuote: Stat;
  /** Volume 24 jam / total dari trade terindeks (termasuk di luar UI LIFTOFF), dalam quote pair. */
  volume24hQuote: Stat;
  volumeTotalQuote: Stat;
  volumeTotalUsd: Stat;
  /** Konversi USD memakai harga ASUMSI pair (devnet tidak punya harga) → selalu MOCK/estimated. */
  priceUsd: Stat;
  marketCapUsd: Stat;
  volume24hUsd: Stat;
  /** Dari harga trade on-chain 24 jam lalu vs harga spot. */
  priceChange24hPct: Stat;
  curveProgressPct: Stat;
  burnedSupplyPct: Stat;
  /** Total token dibakar (unit token, dari burn on-chain terkonfirmasi). */
  burnedTokens: Stat;
  /** Saldo reserve (ledger) dalam quote pair; USD-nya MOCK. */
  reserveBalanceQuote: Stat;
  reserveBalanceUsd: Stat;
  /** Hasil anti-copycat saat launch (Spec §7). */
  riskLevel: "low" | "medium" | "high";
}

/** GET /api/tokens?filter=&pair=&cursor= */
export interface TokenListResponse {
  items: TokenSummary[];
  nextCursor: string | null;
}

export interface PricePoint {
  t: string;
  /** Harga dalam quote pair (dari event trade on-chain). */
  priceQuote: string;
  /** Setara USD dengan harga asumsi pair (estimasi). null = tanpa harga (mainnet). */
  priceUsd: string | null;
}

export const TRADE_SIDES = ["buy", "sell"] as const;
export type TradeSide = (typeof TRADE_SIDES)[number];

export interface Trade {
  signature: string;
  side: TradeSide;
  wallet: string;
  amountToken: string;
  amountQuote: string;
  quoteSymbol: string;
  priceUsd: string | null;
  createdAt: string;
  status: StatStatus;
}

export const CANDLE_INTERVALS = ["1m", "5m", "15m", "1h", "1d"] as const;
export type CandleInterval = (typeof CANDLE_INTERVALS)[number];
export const CANDLE_INTERVAL_SECONDS: Record<CandleInterval, number> = {
  "1m": 60,
  "5m": 300,
  "15m": 900,
  "1h": 3_600,
  "1d": 86_400,
};

/** Satu candle dari trade on-chain terindeks, harga dalam quote pair. */
export interface Candle {
  /** Awal periode, detik Unix (UTC). */
  time: number;
  open: string;
  high: string;
  low: string;
  close: string;
  /** null = desimal quote tidak dikenal. */
  volumeQuote: string | null;
  trades: number;
}

/** GET /api/tokens/:mint/candles */
export interface CandleSeries {
  interval: CandleInterval;
  candles: Candle[];
  /** Harga quote saat ini dalam USD, untuk menampilkan riwayat sebagai estimasi. null = tak terverifikasi. */
  quoteUsd: string | null;
}

/** GET /api/tokens/:mint */
export interface TokenDetail extends TokenSummary {
  description: string;
  links: TokenLinks;
  totalSupply: string;
  /** Curve: quote di curve; CPMM: cadangan sisi quote pool (indexer). */
  liquidityQuote: Stat;
  liquidityUsd: Stat;
  holders: Stat;
  /** Sisa quote yang dibutuhkan sampai graduation, dalam unit pair. */
  curveRemainingQuote: Stat;
  curveRemainingUsd: Stat;
  poolAddress: string | null;
  graduation: GraduationInfo | null;
  /** Harga dari trade on-chain terindeks (kosong = belum ada trade). */
  chart: PricePoint[];
  recentTrades: Trade[];
}

/**
 * Spec §14: not_graduated → migrating (curve penuh, menunggu migrasi Raydium) → pool_pending
 * (curve status 2, pool belum terbaca) → verified (pool & LP terverifikasi) | failed (pool tidak
 * sesuai harapan; reserve deployment tetap mati).
 */
export const GRADUATION_STATES = [
  "not_graduated",
  "migrating",
  "pool_pending",
  "verified",
  "failed",
] as const;
export type GraduationState = (typeof GRADUATION_STATES)[number];

export interface GraduationCheck {
  id: string;
  ok: boolean;
  detail: string;
}

export interface GraduationInfo {
  state: GraduationState;
  launchPool: string;
  cpmmPool: string | null;
  migrateSignature: string | null;
  migratedAt: string | null;
  lpMint: string | null;
  /** Persentase dari total LP pool saat migrasi (bukti on-chain, bukan klaim). */
  lpBurnedPct: string | null;
  lpLockedPct: string | null;
  lpFreePct: string | null;
  addLiquiditySupported: boolean;
  /** Reserve monitoring hanya aktif setelah pool terverifikasi & mendukung add-liquidity. */
  reserveMonitoringActive: boolean;
  checks: GraduationCheck[];
  checkedAt: string;
  verifiedAt: string | null;
}

// ---------------------------------------------------------------- ledger

/** `allocated_treasury` hanya ada di entri lama (model sebelum Spec); model 80/20 tidak memakainya. */
export type FeeEntryType =
  "received" | "allocated_buyback" | "allocated_reserve" | "allocated_treasury" | "correction";

/** Asal fee: `creator_fee` = creator fee (curve/CPMM) ke master wallet → 80/20 (Spec §9). */
export type FeeSource = "creator_fee" | "platform_vault" | "referral";

export type Attribution = "verified" | "estimated";

export interface FeeLedgerEntry {
  id: string;
  sourceSignature: string;
  tokenMint: string;
  amount: string;
  assetSymbol: string;
  entryType: FeeEntryType;
  source: FeeSource;
  attribution: Attribution;
  createdAt: string;
}

export type BurnSource = "buyback";

export interface BurnLedgerEntry {
  id: string;
  tokenMint: string;
  amountBurned: string;
  /** Quote yang dipakai untuk membeli. */
  amountSpent: string;
  assetSymbol: string;
  source: BurnSource;
  buybackSignature: string;
  burnSignature: string;
  createdAt: string;
}

export type ReserveEntryType = "contribution" | "deployment" | "correction";

export interface ReserveLedgerEntry {
  id: string;
  tokenMint: string;
  entryType: ReserveEntryType;
  amount: string;
  assetSymbol: string;
  txSignature: string;
  createdAt: string;
}

/** Parameter reserve yang berlaku untuk satu token (RESERVE_CONFIG + override). */
export interface EffectiveReserveParams {
  minBalanceToDeployUsd: number;
  maxDeployPctPerRunBps: number;
  maxDeployAbsPerRunUsd: number;
  maxReserveShareOfPoolBps: number;
  cooldownSeconds: number;
  maxDeploysPerWindow: number;
  deployWindowSeconds: number;
  minTimeSinceGraduationSeconds: number;
  /** Nama parameter yang ditimpa per token. */
  overridden: string[];
}

export type LpLockStatus = "not_applicable" | "pending" | "locked" | "unverified";

/** Status vault Conviction Reserve satu token. */
export interface ReserveState {
  tokenMint: string;
  mode: ReserveMode;
  paused: boolean;
  /** Saldo reserve dari creator fee yang sudah di-claim & direkonsiliasi (dana diterima). */
  balance: Stat;
  balanceUsd: Stat;
  /** Porsi reserve dari fee yang tercatat tetapi belum di-claim (bukan saldo diterima). */
  awaitingClaim: Stat;
  totalContributed: Stat;
  totalDeployed: Stat;
  createdAt: string;
  lastDeployAt: string | null;
  /** Paling cepat kapan deployment berikutnya boleh jalan (cooldown). */
  nextActionEarliestAt: string | null;
  deploysInWindow: number;
  params: EffectiveReserveParams;
  /** Alasan deploy sedang ditahan (hasil evaluateDeployment terakhir). */
  holdReasons: string[];
  poolAddress: string | null;
  lpLock: { status: LpLockStatus; proofSignature: string | null };
  custody: ReserveCustodyView | null;
  latestDecision: ReserveDecisionView | null;
  deployments: ReserveDeploymentView[];
}

/**
 * Akun kustodi reserve token (Tahap 8, MVP Spec §13 "segregated custody"): akun token SPL dengan
 * alamat createWithSeed(master, seed). Bukan program vault — lihat `trustNote`.
 */
export interface ReserveCustodyView {
  kind: "segregated_custody";
  quoteAccount: string;
  tokenAccount: string;
  /** Di akun kustodi (bebas untuk deployment berikutnya). */
  inCustody: Stat;
  /** Sudah diterima tetapi masih di ATA quote master (menunggu dipindah, batching). */
  inMasterAccount: Stat;
  /** Sisa token hasil swap deployment yang tidak terpakai add-liquidity (tetap milik reserve ini). */
  tokenResidual: Stat;
  trustNote: string;
}

/** Hasil evaluasi terakhir worker reserve (Spec §11 Phase 2 + §12), dari reserve_decisions. */
export interface ReserveDecisionView {
  at: string;
  allowed: boolean;
  reasons: string[];
  failedSafetyChecks: string[];
  poolLiquidity: Stat;
  poolLiquidityUsd: Stat;
  depth2Pct: Stat;
  priceImpactBps: number;
  volumeChangeBps: number | null;
  oneHourMoveBps: number;
}

/** Satu deployment Conviction Reserve (Spec §11 Phase 5): semuanya bisa dicek di explorer. */
export interface ReserveDeploymentView {
  id: string;
  tokenName: string;
  ticker: string;
  tokenMint: string;
  quoteSymbol: string;
  reserveBefore: string;
  amountDeployed: string;
  swapIn: string;
  quoteAdded: string;
  tokenAdded: string;
  pool: string;
  lpMint: string;
  lpBurned: string;
  signature: string;
  /** `burned` = LP dibakar di transaksi yang sama, terverifikasi dari transaksi on-chain. */
  lock: { method: "burn"; verified: boolean; proofSignature: string };
  remainingReserve: string;
  createdAt: string;
}

/** GET /api/reserve — riwayat deployment semua token + total. */
export interface ReserveOverview {
  deployments: ReserveDeploymentView[];
  tokensReinforced: number;
  /** Per quote pair: total quote reserve yang dideploy (native, terverifikasi). */
  totalDeployedNative: Stat[];
  totalDeployedUsd: Stat;
  custodyKind: "segregated_custody";
  configStatus: "unverified" | "verified";
}

/**
 * Claim creator fee oleh master wallet (Tahap 7) + hasil rekonsiliasinya: `verified` = Δ claim
 * persis sama dengan alokasi ledger per token; `estimated` = ada selisih yang dikoreksi pro-rata;
 * `pending` = belum direkonsiliasi (dana belum dihitung sebagai diterima/bisa dibelanjakan).
 */
export interface FeeClaimView {
  id: string;
  kind: "claim_curve" | "claim_cpmm" | "fee_forward";
  status: "pending" | "verified" | "estimated";
  signature: string | null;
  claimed: string;
  assetSymbol: string;
  createdAt: string;
  tokens: Array<{ tokenMint: string; ticker: string; ledger: string; correction: string }>;
}

/** Satu buyback token itu sendiri + burn semua hasilnya (Spec §9). */
export interface BuybackView {
  id: string;
  tokenMint: string;
  ticker: string;
  route: "launchlab" | "cpmm" | string;
  status: "burned" | "awaiting_burn" | "in_progress" | "failed" | "expired";
  spent: string;
  assetSymbol: string;
  bought: string | null;
  burned: string | null;
  buybackSignature: string | null;
  burnSignature: string | null;
  createdAt: string;
  error: string | null;
}

/** Spec §16 Section 2 dari ledger nyata (economic engine). */
export interface TokenEconomics {
  /** Alokasi buyback 80% dari creator fee yang SUDAH di-claim & direkonsiliasi. */
  feesAllocated: Stat;
  /** Alokasi buyback dari fee yang tercatat per trade tetapi belum di-claim (bukan dana diterima). */
  allocationAwaitingClaim: Stat;
  tokensPurchased: Stat;
  quoteSpent: Stat;
  /** Budget yang sudah di-claim tetapi belum dibelanjakan (menunggu threshold minimum). */
  budgetAvailable: Stat;
  minBuyback: Stat;
  latestBuyback: BuybackView | null;
  claims: FeeClaimView[];
  buybacks: BuybackView[];
}

/** GET /api/tokens/:mint/ledger */
export interface TokenLedger {
  fees: FeeLedgerEntry[];
  burns: BurnLedgerEntry[];
  reserve: ReserveLedgerEntry[];
  reserveState: ReserveState;
  economics: TokenEconomics;
  totals: {
    feesReceived: Stat;
    allocatedBuyback: Stat;
    allocatedReserve: Stat;
    burnedTokens: Stat;
    burnedSupplyPct: Stat;
    buybackPending: Stat;
  };
}

// ---------------------------------------------------------------- launch

export interface LaunchInput {
  name: string;
  ticker: string;
  description: string;
  website: string;
  telegram: string;
  /** Akun X proyek (opsional): `@handle` atau URL x.com. Dicek duplikasinya (Spec §7). */
  x: string;
  /** `Pair.id` dari GET /api/pairs. */
  pairId: string;
  /** ID gambar dari POST /api/uploads/image (pHash dihitung server). */
  imageRef: string | null;
}

export type ValidationField =
  | "name"
  | "ticker"
  | "image"
  | "wallet"
  | "x_account"
  | "x"
  | "website"
  | "telegram"
  | "pair"
  | "description";

export interface ValidationReason {
  field: ValidationField;
  code: string;
  message: string;
}

export interface RiskIndicatorView {
  code: string;
  field: "name" | "ticker" | "image" | "x" | "website" | "telegram";
  weight: number;
  message: string;
  relatedTicker: string | null;
}

/** Klasifikasi anti-copycat Spec §7 beserta alasannya. */
export interface RiskReport {
  level: "low" | "medium" | "high";
  score: number;
  indicators: RiskIndicatorView[];
  /** High diblok otomatis; true jika banding untuk input ini sudah disetujui pemilik. */
  appealApproved: boolean;
}

/** POST /api/launch/validate */
export interface ValidateLaunchResponse {
  result: "ok" | "rejected";
  tickerNormalized: string;
  reasons: ValidationReason[];
  /** Catatan non-blokir, mis. sumber data pasar eksternal tidak tersedia di devnet. */
  warnings: string[];
  /** null jika input belum cukup untuk dinilai. */
  risk: RiskReport | null;
}

export type AppealStatus = "pending" | "approved" | "rejected" | "used";

/** Banding launch High-risk (Spec §7 "appeal mechanism"). */
export interface LaunchAppeal {
  id: string;
  status: AppealStatus;
  wallet: string;
  name: string;
  ticker: string;
  pairId: string;
  links: TokenLinks;
  imageUrl: string | null;
  message: string;
  risk: RiskReport;
  reviewNote: string | null;
  reviewedBy: string | null;
  reviewedAt: string | null;
  createdAt: string;
}

/** POST /api/uploads/image */
export interface ImageUploadResponse {
  imageRef: string;
  imageUrl: string;
  imageHash: string;
}

/** Error standar API (4xx/5xx). */
export interface ApiError {
  error: { code: string; message: string; reasons?: ValidationReason[] };
}

export interface LaunchTimelineEntry {
  status: LaunchStatus;
  at: string;
}

/** GET /api/launch/:id (dan response POST /api/launch) */
export interface LaunchJob {
  id: string;
  tokenId: string;
  idempotencyKey: string;
  status: LaunchStatus;
  attemptCount: number;
  lastError: string | null;
  /** Hanya terisi setelah `live`. */
  mint: string | null;
  /** Signature transaksi create yang mendarat (hanya setelah `live`). */
  signature: string | null;
  /**
   * Jalur pengiriman transaksi terakhir: `rpc` (devnet; BUKAN private bundle) atau `jito`
   * (bundle, mainnet). null sebelum ada transaksi.
   */
  sendMode: "rpc" | "jito" | null;
  bundleId: string | null;
  token: { name: string; ticker: string; quoteSymbol: string };
  timeline: LaunchTimelineEntry[];
  /**
   * Biaya launch yang dibayar creator (null = launch tanpa deposit). `kept` setelah live;
   * `refund_pending` → `refunded` jika launch gagal permanen.
   */
  deposit: {
    lamports: string;
    signature: string;
    status: "received" | "refund_pending" | "refunded" | "kept";
    refundSignature: string | null;
  } | null;
}

// ---------------------------------------------------------------- auth

/**
 * Cara menautkan akun X (opsional): `x` = OAuth 2.0 X sungguhan; `dev` = tautan development
 * tanpa X (DITANDAI di UI, hanya jika X_CLIENT_ID kosong dan bukan production).
 */
export type XLinkMode = "x" | "dev" | "disabled";

/** GET /api/auth/me */
export interface SessionInfo {
  xLinkMode: XLinkMode;
  /** `null` = belum sign-in dengan wallet. */
  user: {
    id: string;
    /** Identitas utama (Sign-In With Solana). */
    wallet: string;
    /** Akun X tertaut (opsional). */
    xHandle: string | null;
    /** Tautan X dibuat lewat dev-link, bukan OAuth X sungguhan. */
    xDevLink: boolean;
    /** Wallet ada di allowlist admin (ADMIN_WALLETS) → panel banding. */
    isAdmin: boolean;
  } | null;
}

/** POST /api/auth/siws/nonce */
export interface SiwsChallenge {
  message: string;
  expiresAt: string;
}

/** GET /api/launch/rules — batas & syarat launch yang berlaku (dari config). */
export interface LaunchRules {
  perWalletPer24h: number;
  perWalletWithXPer24h: number;
  globalPerDay: number;
  minBalanceSol: string;
  minWalletAgeDays: number;
  /**
   * Biaya launch yang dibayar creator: transfer `lamports` SOL ke `recipient` (master wallet)
   * sebelum launch. Disimpan jika launch live; dikembalikan hanya jika launch gagal permanen.
   */
  deposit: { enabled: boolean; sol: string; lamports: string; recipient: string };
  /** Untuk user yang login: sisa kuota 24 jam wallet ini. */
  remainingForWallet: number | null;
}

// ---------------------------------------------------------------- health

export type HealthCheckState = "ok" | "down" | "not_configured";

/** GET /api/health */
export interface HealthResponse {
  status: "ok" | "degraded";
  service: "api";
  cluster: string;
  checks: {
    db: HealthCheckState;
    redis: HealthCheckState;
    rpc: HealthCheckState;
    signer: HealthCheckState;
  };
}

// ---------------------------------------------------------------- platform

export type ActivityKind = "trade" | "burn" | "launch" | "reserve";

/** GET /api/activity (usulan endpoint tambahan Tahap 3) */
export interface ActivityItem {
  id: string;
  kind: ActivityKind;
  ticker: string;
  tokenMint: string;
  summary: string;
  amountUsd: Stat;
  signature: string;
  createdAt: string;
}

/** GET /api/stats — statistik live homepage (Spec §17), dari data terverifikasi. */
export interface PlatformStats {
  tokensLaunched: Stat;
  /** Volume dari trade yang tercatat (receipt on-chain lewat LIFTOFF), setara USD asumsi. */
  tradingVolumeUsd: Stat;
  /** Jumlah token yang dibakar (unit token, semua koin) dari burn on-chain terkonfirmasi. */
  tokensBurned: Stat;
  reserveAccumulatedUsd: Stat;
  liquidityReinforcedUsd: Stat;
  /** Angka native on-chain per quote pair (verified), dasar konversi USD di atas. */
  native: {
    tradingVolume: Stat[];
    reserveAccumulated: Stat[];
    liquidityReinforced: Stat[];
  };
  /** Kapan indexer terakhir memperbarui data pasar (null = indexer belum jalan). */
  indexerUpdatedAt: string | null;
}

export interface TokenLedgerRow {
  tokenMint: string;
  ticker: string;
  quoteSymbol: string;
  attribution: Attribution;
  /** USD memakai harga asumsi pair; null = tanpa harga (mainnet), pakai angka native. */
  feesReceivedUsd: string | null;
  buybackUsd: string | null;
  reserveUsd: string | null;
  /** Jumlah native dalam `quoteSymbol`, dari ledger. */
  feesReceivedNative: string;
  buybackNative: string;
  reserveNative: string;
  burnedSupplyPct: string;
}

/** GET /api/transparency (usulan endpoint tambahan Tahap 3) */
export interface TransparencySummary {
  verified: {
    feesReceivedUsd: Stat;
    burnedUsd: Stat;
    reserveContributedUsd: Stat;
    reserveDeployedUsd: Stat;
    /** Total native per aset (angka USD di atas bisa tidak tersedia). */
    native: {
      feesReceived: Stat[];
      burned: Stat[];
      reserveContributed: Stat[];
      reserveDeployed: Stat[];
    };
  };
  estimated: {
    feesReceivedUsd: Stat;
    buybackPendingUsd: Stat;
  };
  platform: {
    tokensLaunched: Stat;
    tokensGraduated: Stat;
    volume24hUsd: Stat;
    /** Biaya pembuatan dibayar launch authority (master wallet, didanai pemilik) — Spec §5. */
    launchCostPaidByMasterWalletSol: Stat;
  };
  perToken: TokenLedgerRow[];
  recentEntries: Array<FeeLedgerEntry & { ticker: string }>;
  /** Economic engine (Tahap 7): claim, rekonsiliasi, buyback, burn — dengan signature. */
  economic: {
    claims: FeeClaimView[];
    buybacks: BuybackView[];
    /** Per quote pair: fee yang di-claim master wallet (terverifikasi on-chain). */
    claimedNative: Stat[];
    /** Per quote pair: quote yang dibelanjakan untuk buyback yang sudah dibakar. */
    spentNative: Stat[];
    health: { status: "ok" | "degraded"; alerts: number; checkedAt: string };
  };
}

/** GET /api/health/economic — alert dasar economic engine. */
/** GET /api/health/status (Tahap 9): ringkasan infrastruktur + semua alert berbasis DB. */
export interface SystemStatusResponse {
  /** down = DB tidak bisa dibaca (alert lain tidak bisa dihitung). */
  status: "ok" | "degraded" | "down";
  service: "api";
  cluster: string;
  checkedAt: string;
  checks: HealthResponse["checks"];
  signer: { reachable: HealthCheckState; paused: boolean | null };
  alerts: Array<{ level: "warn" | "critical"; code: string; message: string }>;
  indexer: {
    liveTokens: number;
    lastIndexedAt: string | null;
    lagMs: number | null;
    erroringAddresses: number;
  } | null;
  economic: EconomicHealthResponse | null;
}

export interface EconomicHealthResponse {
  status: "ok" | "degraded";
  checkedAt: string;
  alerts: Array<{ level: "warn" | "critical"; code: string; message: string }>;
  workers: Array<{
    name: string;
    lastRunAt: string;
    lastOkAt: string | null;
    consecutiveFailures: number;
    lastError: string | null;
  }>;
  masterLamports: string | null;
  funds: Array<{ assetMint: string; heldByLedger: string; onchain: string }>;
}

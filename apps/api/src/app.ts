import cookie from "@fastify/cookie";
import { refreshQuoteAssets, type Db } from "@liftoff/db";
import {
  RATE_LIMITS,
  usdRatesFor,
  type QuotePriceBook,
  type ApiResponse,
  type DataSource,
  type SolPriceReader,
  type StonkFunAdapter,
  type UsdRates,
} from "@liftoff/shared";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { ZodError } from "zod";
import { loadConfig, type ApiConfig } from "./config";
import { HttpError } from "./lib/errors";
import type { DepositVerifier } from "./lib/deposit";
import type { ExternalTickerSource } from "./lib/external-tickers";
import { ImageStore } from "./lib/images";
import type { KvStore } from "./lib/kv";
import type { LaunchEnqueuer } from "./lib/launch-queue";
import type { TradeService } from "./lib/trade";
import { enforceRateLimit } from "./lib/rate-limit";
import { SessionManager, type SessionUser } from "./lib/session";
import type { WalletChecker } from "./lib/wallet-check";
import { authRoutes } from "./routes/auth";
import { economicHealthRoutes, healthRoutes } from "./routes/health";
import { launchRoutes } from "./routes/launch";
import { metadataRoutes } from "./routes/metadata";
import { platformRoutes } from "./routes/platform";
import { tokenRoutes } from "./routes/tokens";
import { tradeRoutes } from "./routes/trade";
import { appealRoutes } from "./routes/appeals";
import { uploadRoutes } from "./routes/uploads";

export interface AppDeps {
  db: Db;
  kv: KvStore;
  external: ExternalTickerSource;
  walletChecker: WalletChecker;
  /** Queue BullMQ `launch` (Tahap 4). */
  launchQueue: LaunchEnqueuer;
  /** Verifikasi deposit launch on-chain (hanya dipakai jika LAUNCH_DEPOSIT_ENABLED=1). */
  depositVerifier: DepositVerifier;
  /** Quote/build/receipt trade (Tahap 5). */
  trade: TradeService;
  /** Akses StonkFun (devnet: emulasi Platform PDA LIFTOFF), Spec §3–6. */
  stonkfun: StonkFunAdapter;
  /** Harga SOL/USD mainnet. Tanpa ini USD mainnet tidak tersedia (gagal tertutup); devnet tidak memakai. */
  solPrice?: SolPriceReader | null;
  /** Harga quote selain SOL. Tanpa ini USD pair lain tampil n/a. */
  quotePrices?: (Pick<QuotePriceBook, "current"> & Partial<Pick<QuotePriceBook, "read">>) | null;
  config?: ApiConfig;
  logger?: boolean;
  /** Untuk test OAuth X. */
  fetchImpl?: typeof fetch;
}

export interface AppContext {
  db: Db;
  kv: KvStore;
  external: ExternalTickerSource;
  walletChecker: WalletChecker;
  launchQueue: LaunchEnqueuer;
  depositVerifier: DepositVerifier;
  trade: TradeService;
  stonkfun: StonkFunAdapter;
  solPrice: SolPriceReader | null;
  /** Harga untuk setara USD saat ini; tidak pernah menunggu jaringan. */
  usdRates(): UsdRates;
  /** Menunggu sebentar harga quote yang baru pertama diminta. Tidak pernah melempar. */
  awaitQuotePrice(mint: string): Promise<void>;
  config: ApiConfig;
  images: ImageStore;
  sessions: SessionManager;
  fetchImpl: typeof fetch;
}

declare module "fastify" {
  interface FastifyRequest {
    /** User yang login (null jika tidak). Dimuat sekali per request. */
    currentUser(): Promise<SessionUser | null>;
    requireUser(): Promise<SessionUser>;
    /** User yang login DAN wallet-nya ada di ADMIN_WALLETS (403 jika tidak). */
    requireAdmin(): Promise<SessionUser>;
  }
}

export function envelope<T>(data: T, source: DataSource = "indexer"): ApiResponse<T> {
  return { data, meta: { source, generatedAt: new Date().toISOString() } };
}

export function parse<T>(schema: { parse(v: unknown): T }, value: unknown): T {
  return schema.parse(value);
}

/** Batas tunggu harga di `GET /api/pairs/:id`; lewat dari ini USD tampil n/a. */
const QUOTE_PRICE_WAIT_MS = 2_500;

export function buildApp(deps: AppDeps): FastifyInstance {
  const config = deps.config ?? loadConfig();
  const app = Fastify({
    logger: deps.logger
      ? { redact: ["req.headers.cookie", "req.headers.authorization", 'res.headers["set-cookie"]'] }
      : false,
    trustProxy: config.trustProxy,
    bodyLimit: 64 * 1024,
  });

  const ctx: AppContext = {
    db: deps.db,
    kv: deps.kv,
    external: deps.external,
    walletChecker: deps.walletChecker,
    launchQueue: deps.launchQueue,
    depositVerifier: deps.depositVerifier,
    trade: deps.trade,
    stonkfun: deps.stonkfun,
    solPrice: deps.solPrice ?? null,
    usdRates: () =>
      usdRatesFor(config.cluster, deps.solPrice?.current() ?? null, deps.quotePrices ?? null),
    awaitQuotePrice: async (mint) => {
      const reading = deps.quotePrices?.read?.(mint);
      if (!reading) return;
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        reading.catch(() => undefined),
        new Promise((resolve) => {
          timer = setTimeout(resolve, QUOTE_PRICE_WAIT_MS);
        }),
      ]);
      clearTimeout(timer);
    },
    config,
    images: new ImageStore(config.uploadDir),
    sessions: new SessionManager(deps.kv, deps.db),
    fetchImpl: deps.fetchImpl ?? fetch,
  };

  // Katalog quote untuk serializer sinkron (pairForMint/pairForToken). Gagal baca tidak menjatuhkan
  // request: quote yang belum dikenal tampil tidak tersedia.
  app.addHook("onRequest", async () => {
    await refreshQuoteAssets(deps.db, config.cluster).catch(() => undefined);
  });

  app.register(cookie, { secret: config.sessionSecret });

  app.decorateRequest("currentUser", function (this: FastifyRequest) {
    const req = this as FastifyRequest & { _user?: Promise<SessionUser | null> };
    req._user ??= ctx.sessions.fromRequest(req);
    return req._user;
  });
  app.decorateRequest("requireUser", async function (this: FastifyRequest) {
    const user = await this.currentUser();
    if (!user) {
      throw new HttpError(401, "login_required", "Connect and sign in with your wallet first.");
    }
    return user;
  });

  app.decorateRequest("requireAdmin", async function (this: FastifyRequest) {
    const user = await this.requireUser();
    if (!config.adminWallets.includes(user.wallet)) {
      throw new HttpError(403, "admin_only", "This wallet is not an admin.");
    }
    return user;
  });

  // Header keamanan dasar untuk semua respons API (Tahap 9). Respons JSON tidak pernah di-render
  // sebagai HTML dan tidak boleh di-frame; data sesi/akun tidak di-cache perantara.
  app.addHook("onSend", async (req, reply) => {
    reply.header("x-content-type-options", "nosniff");
    reply.header("x-frame-options", "DENY");
    reply.header("referrer-policy", "no-referrer");
    if (req.url.startsWith("/api/auth") || req.url.startsWith("/api/admin")) {
      reply.header("cache-control", "no-store");
    }
  });

  // Rate limit global per IP untuk semua endpoint API.
  app.addHook("onRequest", async (req) => {
    if (req.url.startsWith("/api/health")) return;
    await enforceRateLimit(ctx.kv, "all", RATE_LIMITS.ipGlobal, { ip: req.ip });
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof HttpError) {
      if (err.headers) reply.headers(err.headers);
      return reply.status(err.statusCode).send(err.toBody());
    }
    if (err instanceof ZodError) {
      return reply.status(400).send({
        error: {
          code: "invalid_input",
          message: err.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; "),
        },
      });
    }
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status >= 400 && status < 500) {
      return reply
        .status(status)
        .send({ error: { code: "bad_request", message: (err as Error).message } });
    }
    req.log.error(err);
    return reply.status(500).send({ error: { code: "internal", message: "Internal error." } });
  });

  app.setNotFoundHandler((_req, reply) =>
    reply.status(404).send({ error: { code: "not_found", message: "Not found." } }),
  );

  app.register(async (scope) => {
    await healthRoutes(scope, ctx);
    await economicHealthRoutes(scope, ctx);
    await authRoutes(scope, ctx);
    await tokenRoutes(scope, ctx);
    await launchRoutes(scope, ctx);
    await metadataRoutes(scope, ctx);
    await uploadRoutes(scope, ctx);
    await platformRoutes(scope, ctx);
    await tradeRoutes(scope, ctx);
    await appealRoutes(scope, ctx);
  });

  return app;
}

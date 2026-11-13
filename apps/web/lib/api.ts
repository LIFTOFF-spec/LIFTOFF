/**
 * Klien API LIFTOFF (Tahap 3). Bentuk response = tipe di `@liftoff/shared`.
 *
 * - Server component memanggil API langsung (`API_INTERNAL_URL`, default http://localhost:4000).
 * - Browser memanggil path relatif `/api/*`, yang di-proxy Next ke API (next.config.ts), sehingga
 *   cookie sesi tetap first-party dan tidak perlu CORS.
 */
import type {
  ActivityItem,
  ApiError,
  ApiResponse,
  BuiltTrade,
  CandleInterval,
  CandleSeries,
  DiscoveryFilter,
  ImageUploadResponse,
  AdoptionStatus,
  LaunchAppeal,
  LaunchInput,
  LaunchJob,
  LaunchRules,
  PairDetail,
  PairListResponse,
  PairSummaryResponse,
  UsedPair,
  PlatformStats,
  ReserveOverview,
  SessionInfo,
  SiwsChallenge,
  SolPriceStatus,
  StonkFunInfo,
  TokenDetail,
  TokenLedger,
  TokenListResponse,
  TradeBuildRequest,
  TradeQuote,
  TradeQuoteRequest,
  TradeReceipt,
  TransparencySummary,
  ValidateLaunchResponse,
} from "@liftoff/shared";

const SERVER_BASE = process.env.API_INTERNAL_URL ?? "http://localhost:4000";

function url(path: string): string {
  return typeof window === "undefined" ? `${SERVER_BASE}${path}` : path;
}

export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly body: ApiError | null,
  ) {
    super(body?.error.message ?? `HTTP ${status}`);
  }
}

/**
 * Saat render di server, teruskan IP pengunjung asli ke API. Tanpa ini semua pengunjung tercatat
 * sebagai satu IP (container web) dan rate limit global API (per IP) cepat habis saat trafik ramai.
 * Aman: Caddy menimpa X-Forwarded-For dengan {client_ip} sebelum request sampai ke web, dan API
 * hanya memercayai header ini dari jaringan Docker privat (TRUST_PROXY=1).
 */
async function forwardedFor(): Promise<Record<string, string>> {
  if (typeof window !== "undefined") return {};
  try {
    const { headers } = await import("next/headers");
    const ip = (await headers()).get("x-forwarded-for");
    return ip ? { "x-forwarded-for": ip } : {};
  } catch {
    // Di luar request (mis. saat build): tidak ada IP pengunjung.
    return {};
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(url(path), {
    cache: "no-store",
    credentials: "same-origin",
    ...init,
    headers: {
      ...(await forwardedFor()),
      ...(init.body && !(init.body instanceof Blob) ? { "content-type": "application/json" } : {}),
      ...init.headers,
    },
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as ApiError | null;
    throw new ApiRequestError(res.status, body);
  }
  return (await res.json()) as T;
}

async function orNull<T>(promise: Promise<T>): Promise<T | null> {
  try {
    return await promise;
  } catch (err) {
    if (err instanceof ApiRequestError && err.status === 404) return null;
    throw err;
  }
}

/** GET /api/tokens/:mint/candles — candle dari trade on-chain terindeks. */
export function getCandles(mint: string, interval: CandleInterval) {
  return request<ApiResponse<CandleSeries>>(
    `/api/tokens/${encodeURIComponent(mint)}/candles?interval=${interval}`,
  );
}

/** GET /api/pairs — dimuat dinamis lewat StonkFunAdapter (Spec §6). */
export function getPairs() {
  return request<ApiResponse<PairListResponse>>("/api/pairs");
}

/** GET /api/pairs/summary — jumlah pair per kategori, untuk halaman selain Create. */
export function getPairSummary() {
  return request<ApiResponse<PairSummaryResponse>>("/api/pairs/summary");
}

/** GET /api/pairs/used — quote yang dipakai token live, dasar filter pair. */
export function getUsedPairs() {
  return request<ApiResponse<UsedPair[]>>("/api/pairs/used");
}

/** GET /api/pairs/:id — pair terpilih: config, raise, harga, dan pemeriksaan mint on-chain. */
export function getPairDetail(id: string) {
  return request<ApiResponse<PairDetail>>(`/api/pairs/${encodeURIComponent(id)}`);
}

/** GET /api/stonkfun — config StonkFun aktif (devnet: emulasi) & fee on-chain. */
export function getStonkFunInfo() {
  return request<ApiResponse<StonkFunInfo>>("/api/stonkfun");
}

/** GET /api/tokens/:mint/adoption — status adopsi token oleh StonkFun. */
export function getAdoption(mint: string) {
  return orNull(
    request<ApiResponse<AdoptionStatus>>(`/api/tokens/${encodeURIComponent(mint)}/adoption`),
  );
}

export interface TokenQuery {
  filter?: DiscoveryFilter | undefined;
  pair?: string | undefined;
  cursor?: string | undefined;
}

/** GET /api/tokens?filter=&pair=&cursor= */
export function getTokens(query: TokenQuery = {}) {
  const params = new URLSearchParams();
  if (query.filter) params.set("filter", query.filter);
  if (query.pair) params.set("pair", query.pair);
  if (query.cursor) params.set("cursor", query.cursor);
  const qs = params.toString();
  return request<ApiResponse<TokenListResponse>>(`/api/tokens${qs ? `?${qs}` : ""}`);
}

/** GET /api/tokens/:mint */
export function getToken(mint: string) {
  return orNull(request<ApiResponse<TokenDetail>>(`/api/tokens/${encodeURIComponent(mint)}`));
}

/** GET /api/tokens/:mint/ledger */
export function getTokenLedger(mint: string) {
  return orNull(
    request<ApiResponse<TokenLedger>>(`/api/tokens/${encodeURIComponent(mint)}/ledger`),
  );
}

/** POST /api/launch/validate */
export function validateLaunch(input: Partial<LaunchInput>) {
  return request<ValidateLaunchResponse>("/api/launch/validate", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

/**
 * POST /api/launch (header Idempotency-Key). Membuat job; worker + signer meluncurkannya (Tahap 4).
 * `depositSignature` = transfer biaya launch creator → master wallet (jika deposit aktif).
 */
export function createLaunch(
  input: LaunchInput,
  idempotencyKey: string,
  depositSignature?: string,
) {
  return request<LaunchJob>("/api/launch", {
    method: "POST",
    body: JSON.stringify(depositSignature ? { ...input, depositSignature } : input),
    headers: { "idempotency-key": idempotencyKey },
  });
}

/** GET /api/launch/:id */
export function getLaunch(id: string) {
  return orNull(request<LaunchJob>(`/api/launch/${encodeURIComponent(id)}`));
}

/** POST /api/uploads/image (byte gambar mentah). */
export function uploadImage(file: Blob) {
  return request<ImageUploadResponse>("/api/uploads/image", {
    method: "POST",
    body: file,
    headers: { "content-type": file.type },
  });
}

/** GET /api/activity */
export function getActivity(limit = 12) {
  return request<ApiResponse<ActivityItem[]>>(`/api/activity?limit=${limit}`);
}

/** GET /api/transparency */
export function getTransparency() {
  return request<ApiResponse<TransparencySummary>>("/api/transparency");
}

/** GET /api/stats — statistik live beranda (Spec §17), dari data terverifikasi. */
/** GET /api/reserve — riwayat deployment Conviction Reserve (Spec §11 Phase 5). */
export function getReserveOverview() {
  return request<ApiResponse<ReserveOverview>>("/api/reserve");
}
export function getPlatformStats() {
  return request<ApiResponse<PlatformStats>>("/api/stats");
}
/** GET /api/price/sol — status harga SOL/USD (mainnet: StonkFun + cek silang Jupiter). */
export function getSolPriceStatus() {
  return request<ApiResponse<SolPriceStatus>>("/api/price/sol");
}
/** GET /api/launch/rules — batas & syarat launch dari config API. */
export function getLaunchRules() {
  return request<LaunchRules>("/api/launch/rules");
}

// ---------------------------------------------------------------- auth

/** GET /api/auth/me */
export function getSession() {
  return request<SessionInfo>("/api/auth/me");
}

/** POST /api/auth/siws/nonce — pesan Sign-In With Solana untuk ditandatangani wallet. */
export function siwsNonce(wallet: string) {
  return request<SiwsChallenge>("/api/auth/siws/nonce", {
    method: "POST",
    body: JSON.stringify({ wallet }),
  });
}

/** POST /api/auth/siws/verify — tanda tangan (base58) atas pesan dari siwsNonce. */
export function siwsVerify(wallet: string, message: string, signature: string) {
  return request<SessionInfo>("/api/auth/siws/verify", {
    method: "POST",
    body: JSON.stringify({ wallet, message, signature }),
  });
}

export function logout() {
  return request<{ ok: true }>("/api/auth/logout", { method: "POST", body: "{}" });
}

/** POST /api/auth/x/dev-link — tautan X development (hanya jika OAuth X belum dikonfigurasi). */
export function devLinkX(handle: string) {
  return request<SessionInfo>("/api/auth/x/dev-link", {
    method: "POST",
    body: JSON.stringify({ handle }),
  });
}

export function unlinkX() {
  return request<SessionInfo>("/api/auth/x/unlink", { method: "POST", body: "{}" });
}

/** URL untuk menautkan akun X lewat OAuth (redirect penuh, bukan fetch). */
export function xLinkUrl(returnTo: string) {
  return `/api/auth/x/login?returnTo=${encodeURIComponent(returnTo)}`;
}

// ---------------------------------------------------------------- trade (Tahap 5)

/** POST /api/trade/quote — estimasi + fee on-chain, tanpa transaksi. */
export function quoteTrade(input: TradeQuoteRequest, signal?: AbortSignal) {
  return request<TradeQuote>("/api/trade/quote", {
    method: "POST",
    body: JSON.stringify(input),
    ...(signal ? { signal } : {}),
  });
}

/** POST /api/trade/build — transaksi unsigned (fee payer = wallet pengguna) + hasil simulasi. */
export function buildTrade(input: TradeBuildRequest) {
  return request<BuiltTrade>("/api/trade/build", { method: "POST", body: JSON.stringify(input) });
}

/** POST /api/trade/confirm — fee yang benar-benar terpotong on-chain (409 = belum terkonfirmasi). */
export function confirmTrade(mint: string, signature: string) {
  return request<TradeReceipt>("/api/trade/confirm", {
    method: "POST",
    body: JSON.stringify({ mint, signature }),
  });
}

// ---------------------------------------------------------------- banding anti-copycat (Spec §7)

/** POST /api/appeals — banding untuk launch yang diblok High risk. */
export function submitAppeal(input: LaunchInput & { message: string }) {
  return request<LaunchAppeal>("/api/appeals", { method: "POST", body: JSON.stringify(input) });
}

/** GET /api/appeals/mine */
export function getMyAppeals() {
  return request<ApiResponse<LaunchAppeal[]>>("/api/appeals/mine");
}

/** GET /api/admin/appeals (admin allowlist). */
export function getAdminAppeals(status: "pending" | "all" = "pending") {
  return request<ApiResponse<LaunchAppeal[]>>(`/api/admin/appeals?status=${status}`);
}

/** POST /api/admin/appeals/:id/review */
export function reviewAppeal(id: string, decision: "approved" | "rejected", note: string) {
  return request<LaunchAppeal>(`/api/admin/appeals/${encodeURIComponent(id)}/review`, {
    method: "POST",
    body: JSON.stringify({ decision, note }),
  });
}

/**
 * Schema Zod bersama frontend & API (Tahap 3).
 *
 * Schema hanya memeriksa BENTUK input. Aturan bisnis (copycat, akun X, ticker eksternal)
 * dicek di API dan dilaporkan sebagai `ValidationReason` yang bisa dibaca pengguna.
 */
import { z } from "zod";
import { CANDLE_INTERVALS, DISCOVERY_FILTERS } from "./api";
import { normalizeXAccount } from "./copycat";
import { isSolanaAddress } from "./siws";
import { TICKER_MAX_LENGTH } from "./ticker";

const httpsUrl = z
  .string()
  .trim()
  .max(200)
  .refine((v) => v === "" || /^https:\/\/[^\s/]+\.[^\s]+$/.test(v), {
    message: "Must be a full URL starting with https://",
  });

/** ID pair dari GET /api/pairs: `sf-<mint>` (mint Solana sampai 44 karakter). */
const pairIdSchema = z.string().min(1).max(64);

/** Input form launch (POST /api/launch/validate dan POST /api/launch). */
export const launchInputSchema = z.object({
  name: z.string().trim().min(2, "Name must be at least 2 characters.").max(32),
  // Huruf/angka Unicode diizinkan di level bentuk agar varian homoglyph mendapat alasan
  // penolakan yang jelas dari pengecekan copycat, bukan sekadar "format salah".
  ticker: z
    .string()
    .trim()
    .min(1)
    .max(TICKER_MAX_LENGTH + 1)
    .regex(/^\$?[\p{L}\p{N}]+$/u, "Ticker may only contain letters and numbers."),
  description: z.string().trim().max(500).default(""),
  website: httpsUrl.default(""),
  telegram: httpsUrl.default(""),
  /** Akun X proyek (opsional): `@handle` atau URL x.com / twitter.com. */
  x: z
    .string()
    .trim()
    .max(200)
    .refine((v) => v === "" || normalizeXAccount(v) !== null, {
      message: "X account must be @handle or an x.com link.",
    })
    .default(""),
  pairId: pairIdSchema,
  /** ID gambar dari POST /api/uploads/image, atau null. */
  imageRef: z
    .string()
    .regex(/^[0-9a-f]{32}$/, "Invalid image reference.")
    .nullable()
    .default(null),
});
export type LaunchInputParsed = z.infer<typeof launchInputSchema>;

/** Validasi longgar untuk cek live saat mengetik: semua field opsional. */
export const launchDraftSchema = launchInputSchema.partial().extend({
  pairId: z.string().max(64).optional(),
});

/** POST /api/appeals — banding launch High-risk (Spec §7). */
export const appealInputSchema = launchInputSchema.extend({
  message: z
    .string()
    .trim()
    .min(20, "Explain in at least 20 characters why this launch is legitimate.")
    .max(1_000),
});

/** POST /api/admin/appeals/:id/review */
export const appealReviewSchema = z.object({
  decision: z.enum(["approved", "rejected"]),
  note: z.string().trim().max(500).default(""),
});

/** Header Idempotency-Key: 8–128 karakter URL-safe (mis. UUID). */
export const idempotencyKeySchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{8,128}$/, "Idempotency-Key must be 8–128 URL-safe characters.");

/** GET /api/tokens/:mint/candles */
export const candleQuerySchema = z.object({
  interval: z.enum(CANDLE_INTERVALS).default("5m"),
});

export const tokenQuerySchema = z.object({
  filter: z.enum(DISCOVERY_FILTERS).default("new"),
  pair: z.string().max(64).optional(),
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(24),
});

/** POST /api/auth/x/dev-link (development saja). */
export const devLinkSchema = z.object({
  handle: z
    .string()
    .trim()
    .regex(/^@?[A-Za-z0-9_]{1,15}$/, "X handle: 1–15 letters, numbers or underscore."),
});

export const solanaAddressSchema = z
  .string()
  .refine(isSolanaAddress, "Must be a Solana wallet address (base58 public key).");

/** POST /api/auth/siws/nonce */
export const siwsNonceSchema = z.object({ wallet: solanaAddressSchema });

/** POST /api/auth/siws/verify — tanda tangan ed25519 (64 byte) dalam base58. */
export const siwsVerifySchema = z.object({
  wallet: solanaAddressSchema,
  message: z.string().min(1).max(2_000),
  signature: z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{64,90}$/, "Invalid signature."),
});
export const uuidSchema = z.uuid();

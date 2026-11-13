/**
 * Kontrak HTTP internal worker → signer (Tahap 4). Signer tidak punya endpoint publik; setiap
 * request (kecuali /health) wajib membawa `Authorization: Bearer <SIGNER_AUTH_TOKEN>`.
 */
import { z } from "zod";

const base64 = z.string().regex(/^[A-Za-z0-9+/]+={0,2}$/, "base64");

export const signerMintRequestSchema = z.object({ jobId: z.uuid() });
export type SignerMintRequest = z.infer<typeof signerMintRequestSchema>;
export interface SignerMintResponse {
  /** Pubkey mint (base58). Secret key mint tidak pernah keluar dari signer. */
  mint: string;
}

export const signerSignRequestSchema = z
  .object({
    purpose: z.enum([
      "launch",
      "deposit_refund",
      "fee_claim",
      "buyback",
      "burn",
      "reserve_fund",
      "reserve_deploy",
    ]),
    /** Launch job (purpose launch / deposit_refund). */
    jobId: z.uuid().optional(),
    /** Baris economic_ops (purpose fee_claim / buyback / burn Tahap 7, reserve_* Tahap 8). */
    opId: z.uuid().optional(),
    /** VersionedTransaction belum ditandatangani, serialisasi base64. */
    transaction: base64.max(4_000),
  })
  .refine(
    (r) =>
      r.purpose === "launch" || r.purpose === "deposit_refund"
        ? !!r.jobId && !r.opId
        : !!r.opId && !r.jobId,
    { message: "launch/deposit_refund butuh jobId; operasi ekonomi butuh opId" },
  );
export type SignerSignRequest = z.infer<typeof signerSignRequestSchema>;
export interface SignerSignResponse {
  signature: string;
  /** Transaksi yang sudah ditandatangani lengkap (base64), siap dikirim. */
  transaction: string;
  /** Pengeluaran SOL master wallet hasil simulasi (lamport, string). */
  spendLamports: string;
}

export const signerPauseRequestSchema = z.object({ reason: z.string().trim().min(3).max(200) });

/** Kode error signer; `retryable` memberi tahu worker apakah boleh dicoba lagi. */
export type SignerErrorCode =
  | "unauthorized"
  | "paused"
  | "invalid_request"
  | "policy_violation"
  | "simulation_failed"
  | "limit_exceeded"
  | "rpc_unavailable"
  | "internal";

export interface SignerErrorBody {
  error: { code: SignerErrorCode; message: string; retryable: boolean; details?: unknown };
}

export interface SignerHealth {
  status: "ok";
  service: "signer";
  cluster: string;
  paused: boolean;
  /** Pubkey master wallet (publik). */
  masterWallet: string;
}

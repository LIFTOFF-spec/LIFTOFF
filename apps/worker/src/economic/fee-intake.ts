/**
 * Strategi fee intake (docs/BUILD_PLAN.md "Fee intake"): bagaimana creator fee sampai ke master
 * wallet sebelum dialokasikan 80% buyback & burn / 20% Conviction Reserve (tidak berubah).
 *
 *  - `claim`     (devnet, Tahap 7): master meng-claim vault creator LaunchLab per quote mint dan
 *                creator fee pool CPMM; Δ claim direkonsiliasi dengan ledger per trade.
 *  - `forwarded` (StonkFun): creator fee launch LaunchLab standar DITERUSKAN otomatis ke wallet
 *                creator. Worker mendeteksi transfer masuk ke ATA quote master yang BUKAN
 *                transaksi master sendiri, mencatatnya sebagai operasi `fee_forward` (confirmed,
 *                tanpa tanda tangan), lalu rekonsiliasi yang sama dengan claim: total diteruskan
 *                vs creator fee per trade di ledger → per token `verified` / `estimated`
 *                (+ correction). Vault creator yang masih berisi (launch lama, scope
 *                `creator-quote-vault`) tetap di-claim sebagai fallback; fee CPMM tetap di-claim.
 *
 * Modul ini murni (klasifikasi), diuji tabel di fee-intake.test.ts.
 */
import type { InboundCredit } from "./ports";

export type ForwardEvidence = "known_forwarder" | "launchlab_trade";

export type ForwardClassification =
  | { ok: true; evidence: ForwardEvidence; forwarder: string | null }
  | { ok: false; reason: string; alert: boolean };

export interface ForwardRules {
  master: string;
  launchlabProgram: string;
  /** Wallet/akun StonkFun yang diketahui meneruskan fee (dikonfirmasi di mainnet, Tahap 10). */
  forwarders: readonly string[];
  /** Mint quote yang dipakai token LIFTOFF live. */
  quoteMints: readonly string[];
}

/**
 * Apakah kredit masuk ke ATA quote master adalah creator fee yang diteruskan StonkFun.
 *  - transaksi yang ditandatangani master = operasi LIFTOFF sendiri (claim, buyback, refund) → abaikan;
 *  - pengirim (owner akun sumber / signer) ada di daftar forwarder → `known_forwarder`;
 *  - transaksi memanggil program LaunchLab (fee diteruskan di dalam trade) → `launchlab_trade`;
 *  - selain itu: dana masuk tak dikenal → TIDAK dihitung sebagai fee (alert, butuh operator).
 */
export function classifyForwardCredit(
  c: InboundCredit,
  rules: ForwardRules,
): ForwardClassification {
  if (c.failed) return { ok: false, reason: "transaksi gagal", alert: false };
  if (c.amount <= 0n) return { ok: false, reason: "bukan kredit masuk", alert: false };
  if (c.signers.includes(rules.master)) {
    return { ok: false, reason: "transaksi master sendiri (claim/buyback)", alert: false };
  }
  if (!rules.quoteMints.includes(c.mint)) {
    return { ok: false, reason: `mint ${c.mint} bukan quote token LIFTOFF`, alert: true };
  }
  const forwarder =
    [...c.sourceOwners, ...c.signers].find((a) => rules.forwarders.includes(a)) ?? null;
  if (forwarder) return { ok: true, evidence: "known_forwarder", forwarder };
  if (c.programs.includes(rules.launchlabProgram)) {
    return { ok: true, evidence: "launchlab_trade", forwarder: c.sourceOwners[0] ?? null };
  }
  return {
    ok: false,
    reason: "dana masuk dari pengirim tak dikenal (bukan forwarder StonkFun)",
    alert: true,
  };
}

/**
 * Apakah SOL biasa yang masuk ke wallet master adalah creator fee StonkFun. Lebih ketat dari kredit
 * token: wallet master juga menerima deposit launch dan isi ulang dari pemilik, jadi HANYA transfer
 * yang ditandatangani forwarder dikenal yang dihitung. Selain itu bukan alert, karena itu normal.
 */
export function classifyNativeForward(
  c: InboundCredit,
  rules: Pick<ForwardRules, "master" | "forwarders">,
): ForwardClassification {
  if (c.failed) return { ok: false, reason: "transaksi gagal", alert: false };
  if (c.amount <= 0n) return { ok: false, reason: "bukan kredit masuk", alert: false };
  if (c.signers.includes(rules.master)) {
    return { ok: false, reason: "transaksi master sendiri", alert: false };
  }
  const forwarder = c.signers.find((a) => rules.forwarders.includes(a)) ?? null;
  if (forwarder) return { ok: true, evidence: "known_forwarder", forwarder };
  return { ok: false, reason: "SOL masuk bukan dari forwarder StonkFun", alert: false };
}

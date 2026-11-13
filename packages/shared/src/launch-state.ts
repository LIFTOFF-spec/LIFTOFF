/**
 * State machine launch (Tahap 4). Satu-satunya sumber kebenaran transisi status `launch_jobs`
 * (dan `tokens.launchStatus`, yang selalu disamakan). Worker dan API hanya boleh berpindah
 * status lewat transisi di tabel ini; semua transisi lain ditolak.
 *
 *   validating ─▶ queued ─▶ submitting ─▶ confirming ─▶ live
 *        │           │          │  ▲            │
 *        └──▶ failed ◀──────────┤  └────────────┤  (kirim ulang, mint keypair SAMA)
 *                    ▲          ▼               ▼
 *                    └──── needs_reconciliation ◀┘
 *
 * - `submitting → queued`: signer dipause / belum ada transaksi yang ditandatangani.
 * - `confirming → submitting`: transaksi sebelumnya terbukti tidak mendarat (blockhash kedaluwarsa,
 *   signature tidak dikenal, pool tidak ada) → bangun ulang dengan mint yang sama.
 * - `needs_reconciliation`: status on-chain tidak jelas (RPC gagal terus); rekonsiliasi memeriksa
 *   signature & pool lalu memindahkan ke live / confirming / submitting / failed.
 * - `live` dan `failed` final.
 */
import type { LaunchStatus } from "./api";

export const LAUNCH_TRANSITIONS: Readonly<Record<LaunchStatus, readonly LaunchStatus[]>> = {
  validating: ["queued", "failed"],
  queued: ["submitting", "failed"],
  submitting: ["confirming", "queued", "failed", "needs_reconciliation"],
  confirming: ["live", "submitting", "failed", "needs_reconciliation"],
  needs_reconciliation: ["live", "confirming", "submitting", "failed"],
  live: [],
  failed: [],
};

export const FINAL_LAUNCH_STATUSES: readonly LaunchStatus[] = ["live", "failed"];

export function isFinalLaunchStatus(status: LaunchStatus): boolean {
  return FINAL_LAUNCH_STATUSES.includes(status);
}

export function canTransition(from: LaunchStatus, to: LaunchStatus): boolean {
  return LAUNCH_TRANSITIONS[from].includes(to);
}

export class InvalidLaunchTransition extends Error {
  constructor(
    readonly from: LaunchStatus,
    readonly to: LaunchStatus,
  ) {
    super(`transisi launch tidak diizinkan: ${from} → ${to}`);
    this.name = "InvalidLaunchTransition";
  }
}

export function assertTransition(from: LaunchStatus, to: LaunchStatus): void {
  if (!canTransition(from, to)) throw new InvalidLaunchTransition(from, to);
}

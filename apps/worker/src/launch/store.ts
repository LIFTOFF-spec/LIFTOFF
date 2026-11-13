/**
 * Perpindahan status launch di DB. Setiap transisi:
 *  - divalidasi terhadap state machine (@liftoff/shared/launch-state),
 *  - optimistic: `UPDATE ... WHERE status = from` — jika worker lain sudah memindahkan job,
 *    transisi ini gagal (TransitionConflict) dan tidak menimpa apa pun,
 *  - menyamakan tokens.launchStatus dan menambah entri timeline.
 */
import type { Db, DbTx, LaunchJob, Prisma, Token, Transaction } from "@liftoff/db";
import { assertTransition, type LaunchStatus, type LaunchTimelineEntry } from "@liftoff/shared";

export type JobWithRelations = LaunchJob & { token: Token; transactions: Transaction[] };

export class TransitionConflict extends Error {
  constructor(jobId: string, from: LaunchStatus, to: LaunchStatus) {
    super(`job ${jobId} bukan lagi ${from} (transisi ke ${to} dibatalkan)`);
    this.name = "TransitionConflict";
  }
}

export async function loadJob(db: Db | DbTx, jobId: string): Promise<JobWithRelations | null> {
  return db.launchJob.findUnique({
    where: { id: jobId },
    include: { token: true, transactions: { orderBy: { createdAt: "asc" } } },
  });
}

export interface TransitionPatch {
  lastError?: string | null;
  mintAddress?: string;
  poolAddress?: string;
  createSignature?: string;
  bundleId?: string | null;
  submissionCount?: { increment: number };
}

export async function transition(
  tx: DbTx,
  job: Pick<LaunchJob, "id" | "tokenId" | "timeline">,
  from: LaunchStatus,
  to: LaunchStatus,
  patch: TransitionPatch = {},
  now = new Date(),
): Promise<void> {
  assertTransition(from, to);
  const timeline = [
    ...((job.timeline as unknown as LaunchTimelineEntry[]) ?? []),
    { status: to, at: now.toISOString() },
  ];
  const res = await tx.launchJob.updateMany({
    where: { id: job.id, status: from },
    data: { ...patch, status: to, timeline: timeline as unknown as Prisma.InputJsonValue },
  });
  if (res.count !== 1) throw new TransitionConflict(job.id, from, to);
  await tx.token.update({ where: { id: job.tokenId }, data: { launchStatus: to } });
}

/** Klaim ticker & akun X dilepas saat launch gagal permanen (ticker bisa dipakai lagi). */
export async function releaseClaims(tx: DbTx, tokenId: string): Promise<void> {
  await tx.tickerClaim.updateMany({
    where: { tokenId, status: "active" },
    data: { status: "released" },
  });
  await tx.xAccountClaim.updateMany({
    where: { tokenId, status: "active" },
    data: { status: "released" },
  });
}

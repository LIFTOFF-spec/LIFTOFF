/**
 * Economic engine (Tahap 7, Spec §9, §13, §20A–B): tiga worker di atas satu penggerak operasi.
 *
 *  fee-processing  claim creator fee (vault creator curve per quote mint, pool CPMM per token)
 *                  → rekonsiliasi Δ claim vs alokasi ledger (verified / estimated + correction).
 *  buyback         per token, hanya bila budget buyback 80% yang sudah di-claim ≥ threshold;
 *                  beli token itu sendiri di curve (sebelum graduate) / pool CPMM (sesudahnya).
 *  burn            bakar SEMUA token hasil satu buyback; burn_ledger hanya dari burn terverifikasi.
 *
 * Setiap transaksi = satu baris economic_ops yang digerakkan `drive()`:
 *   pending → (signer: allowlist + budget + simulasi) → signed [signature + tx disimpan DULU]
 *   → kirim → submitted → confirmed (Δ saldo dibaca dari transaksi on-chain) | failed | expired.
 * Restart di titik mana pun aman: operasi `signed/submitted` dicek statusnya dan transaksi yang
 * SAMA dikirim ulang; operasi baru untuk target yang sama hanya dibuat setelah yang lama terbukti
 * gagal/kedaluwarsa (blockhash lewat dan signature tidak pernah mendarat). Dua proses yang berjalan
 * bersamaan ditahan partial unique index (satu operasi aktif per jenis+target) dan CAS status.
 */
import {
  buybackBudgets,
  Prisma,
  reconcileClaimAsset,
  refreshQuoteAssets,
  resolveTokenPair,
  type Db,
  type EconomicOp,
} from "@liftoff/db";
import {
  perQuote,
  type EconomicSignPurpose,
  type PairConfig,
  type PlatformAddresses,
  type SolanaCluster,
  WSOL_MINT,
} from "@liftoff/shared";
import { SignerClientError, type BuiltTx, type SignerClient } from "../launch/ports";
import type {
  EconomicChain,
  EconomicLogger,
  EconomicWorkerSettings,
  InboundCredit,
  LandedTx,
} from "./ports";
import { classifyForwardCredit, classifyNativeForward, type ForwardEvidence } from "./fee-intake";
import { buildReserveOp, finalizeReserveOp } from "./reserve-ops";

export type OpOutcome = "confirmed" | "failed" | "expired" | "waiting" | "blocked";

const ACTIVE = ["pending", "signed", "submitted"] as const;
const PURPOSE: Record<EconomicOp["kind"], EconomicSignPurpose> = {
  claim_curve: "fee_claim",
  claim_cpmm: "fee_claim",
  buyback: "buyback",
  burn: "burn",
  reserve_fund: "reserve_fund",
  reserve_deploy: "reserve_deploy",
  // Tidak pernah ditandatangani: kredit yang diteruskan StonkFun hanya diamati on-chain.
  fee_forward: "fee_claim",
};
const INTAKE_KINDS = ["claim_curve", "claim_cpmm", "fee_forward"] as const;

export interface EconomicDeps {
  db: Db;
  chain: EconomicChain;
  signer: SignerClient;
  sender: { send(signedBase64: string): Promise<unknown> };
  cluster: SolanaCluster;
  platform: PlatformAddresses;
  config: EconomicWorkerSettings;
  logger: EconomicLogger;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
}

export interface CycleResult {
  confirmed: number;
  failed: number;
  expired: number;
  created: number;
  skipped: Array<{ target: string; reason: string }>;
  /** Signer dipause / batas tercapai: siklus berhenti lebih awal. */
  blocked: string | null;
}

export const emptyResult = (): CycleResult => ({
  confirmed: 0,
  failed: 0,
  expired: 0,
  created: 0,
  skipped: [],
  blocked: null,
});

export const dec = (v: bigint) => new Prisma.Decimal(v.toString());
export const big = (d: Prisma.Decimal | null | undefined) => (d ? BigInt(d.toFixed(0)) : 0n);
const isReconciled = (details: unknown) =>
  (details as { reconciled?: boolean } | null)?.reconciled === true;
const isUniqueViolation = (err: unknown) =>
  err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";

export class EconomicEngine {
  constructor(private readonly deps: EconomicDeps) {}

  private get db() {
    return this.deps.db;
  }
  private get cfg() {
    return this.deps.config;
  }
  private now() {
    return this.deps.now?.() ?? new Date();
  }
  private sleep(ms: number) {
    return this.deps.sleep ? this.deps.sleep(ms) : new Promise((r) => setTimeout(r, ms));
  }
  private get master() {
    return this.deps.platform.masterWallet;
  }
  get spendingEnabled() {
    return this.cfg.feeSpendingEnabled;
  }
  private get reserveDeps() {
    const { db, chain, cluster, logger } = this.deps;
    return { db, chain, cluster, logger, master: this.master };
  }

  private async pairOf(token: {
    quoteMint: string;
    quoteConfigId: string;
  }): Promise<PairConfig | null> {
    return (await resolveTokenPair(this.db, this.deps.cluster, token)) ?? null;
  }

  // ---------------------------------------------------------------- penggerak operasi

  /** Membuat operasi baru; null bila target sudah punya operasi aktif (worker lain lebih dulu). */
  async createOp(data: {
    kind: EconomicOp["kind"];
    target: string;
    assetMint: string;
    tokenMint?: string | null;
    amountIn?: bigint;
    minOut?: bigint;
    parentOpId?: string;
    details?: Record<string, unknown>;
  }): Promise<EconomicOp | null> {
    const seq = await this.db.economicOp.count({ where: { kind: data.kind, target: data.target } });
    try {
      return await this.db.economicOp.create({
        data: {
          kind: data.kind,
          target: data.target,
          assetMint: data.assetMint,
          tokenMint: data.tokenMint ?? null,
          idempotencyKey: `${data.kind}:${data.target}:${seq + 1}`,
          amountIn: data.amountIn !== undefined ? dec(data.amountIn) : null,
          minOut: data.minOut !== undefined ? dec(data.minOut) : null,
          parentOpId: data.parentOpId ?? null,
          details: (data.details ?? {}) as Prisma.InputJsonValue,
        },
      });
    } catch (err) {
      if (isUniqueViolation(err)) return null;
      throw err;
    }
  }

  private async buildFor(op: EconomicOp): Promise<BuiltTx> {
    const { chain } = this.deps;
    switch (op.kind) {
      case "claim_curve":
        return chain.buildClaimCurve(op.assetMint);
      case "claim_cpmm":
        return chain.buildClaimCpmm(op.target);
      case "buyback": {
        const token = await this.db.token.findUnique({ where: { mint: op.tokenMint! } });
        const pair = token ? await this.pairOf(token) : null;
        if (!pair) throw new Error("pair token tidak dikenal");
        return chain.buildBuyback({
          mint: op.tokenMint!,
          pair,
          amountIn: big(op.amountIn),
          minOut: big(op.minOut),
        });
      }
      case "burn": {
        const amount = big(op.amountIn);
        // ATA ditutup (rent kembali) hanya bila isinya persis hasil buyback ini.
        const balance = await chain.tokenBalance(op.target);
        return chain.buildBurn({ mint: op.tokenMint!, amount, closeAccount: balance === amount });
      }
      case "reserve_fund":
      case "reserve_deploy":
        return buildReserveOp(this.reserveDeps, op);
      case "fee_forward":
        throw new Error("fee_forward diamati on-chain, tidak dibangun");
    }
  }

  /** Menggerakkan satu operasi sejauh mungkin dalam siklus ini. */
  async drive(op: EconomicOp): Promise<OpOutcome> {
    let current = op;
    if (current.status === "pending") {
      const signed = await this.signAndPersist(current);
      if (typeof signed === "string") return signed;
      current = signed;
    }
    if (current.status === "signed" || current.status === "submitted") {
      return this.confirm(current);
    }
    return current.status === "confirmed"
      ? "confirmed"
      : current.status === "failed"
        ? "failed"
        : "expired";
  }

  private async signAndPersist(op: EconomicOp): Promise<EconomicOp | OpOutcome> {
    let built: BuiltTx;
    let signed: { signature: string; transaction: string };
    try {
      built = await this.buildFor(op);
      signed = await this.deps.signer.sign({
        purpose: PURPOSE[op.kind],
        opId: op.id,
        transaction: built.transaction,
      });
    } catch (err) {
      const message = (err as Error).message;
      const blocked =
        err instanceof SignerClientError &&
        (err.retryable || err.code === "paused" || err.code === "limit_exceeded");
      if (blocked) {
        await this.db.economicOp.update({
          where: { id: op.id },
          data: { lastError: message },
        });
        this.deps.logger.warn(
          { opId: op.id, kind: op.kind, code: (err as SignerClientError).code },
          "operasi tertahan",
        );
        return "blocked";
      }
      if (!(err instanceof SignerClientError)) {
        // Error membangun transaksi (RPC, pool belum terbaca): biarkan pending, coba lagi nanti.
        await this.db.economicOp.update({ where: { id: op.id }, data: { lastError: message } });
        this.deps.logger.warn(
          { opId: op.id, kind: op.kind, err: message },
          "gagal membangun transaksi",
        );
        return "waiting";
      }
      // Ditolak permanen (policy / simulasi gagal, mis. slippage terlampaui): dana dilepas.
      await this.db.economicOp.updateMany({
        where: { id: op.id, status: "pending" },
        data: { status: "failed", lastError: message, attempts: { increment: 1 } },
      });
      this.deps.logger.warn(
        { opId: op.id, kind: op.kind, code: err.code, err: message },
        "operasi ditolak signer",
      );
      return "failed";
    }
    // Write-ahead (CAS): hanya proses yang memindahkan pending → signed yang boleh mengirim.
    const moved = await this.db.economicOp.updateMany({
      where: { id: op.id, status: "pending" },
      data: {
        status: "signed",
        signature: signed.signature,
        signedTx: signed.transaction,
        lastValidBlockHeight: BigInt(built.lastValidBlockHeight),
        attempts: { increment: 1 },
        lastError: null,
      },
    });
    if (moved.count === 0) return "waiting"; // proses lain lebih dulu; transaksi ini dibuang
    await this.send(op.id, signed.transaction);
    return (await this.db.economicOp.findUniqueOrThrow({ where: { id: op.id } })) as EconomicOp;
  }

  private async send(opId: string, signedTx: string) {
    try {
      await this.deps.sender.send(signedTx);
      await this.db.economicOp.updateMany({
        where: { id: opId, status: "signed" },
        data: { status: "submitted" },
      });
    } catch (err) {
      // Tetap `signed`: transaksi yang sama dikirim ulang di pengecekan berikutnya.
      await this.db.economicOp.update({
        where: { id: opId },
        data: { lastError: `kirim gagal: ${(err as Error).message}` },
      });
    }
  }

  private async confirm(op: EconomicOp): Promise<OpOutcome> {
    const { chain } = this.deps;
    const deadline = this.now().getTime() + this.cfg.confirmWaitMs;
    let resent = false;
    for (;;) {
      const [status] = await chain.signatureStatuses([op.signature!]);
      if (
        status &&
        (status.confirmationStatus === "confirmed" || status.confirmationStatus === "finalized")
      ) {
        if (status.err) {
          await this.db.economicOp.updateMany({
            where: { id: op.id, status: { in: ["signed", "submitted"] } },
            data: {
              status: "failed",
              slot: BigInt(status.slot),
              lastError: `gagal on-chain: ${JSON.stringify(status.err)}`,
            },
          });
          return "failed";
        }
        const landed = await chain.landedTx(op.signature!);
        if (!landed) return "waiting"; // RPC belum menyajikan transaksi; cek lagi nanti
        await this.finalize(op, landed);
        return "confirmed";
      }
      if (!status) {
        const height = await chain.blockHeight();
        if (op.lastValidBlockHeight !== null && BigInt(height) > op.lastValidBlockHeight) {
          // Blockhash kedaluwarsa: cek sekali lagi (riwayat) sebelum menyatakan tidak mendarat.
          const [again] = await chain.signatureStatuses([op.signature!]);
          if (!again) {
            await this.db.economicOp.updateMany({
              where: { id: op.id, status: { in: ["signed", "submitted"] } },
              data: {
                status: "expired",
                lastError: "blockhash kedaluwarsa, transaksi tidak mendarat",
              },
            });
            return "expired";
          }
          continue;
        }
        if (!resent && op.signedTx) {
          await this.send(op.id, op.signedTx);
          resent = true;
          continue; // cek status sekali lagi segera setelah kirim ulang
        }
      }
      if (this.now().getTime() >= deadline) return "waiting";
      await this.sleep(this.cfg.confirmPollMs);
    }
  }

  /** Membaca hasil on-chain operasi yang sudah mendarat lalu menandainya confirmed (final). */
  private async finalize(op: EconomicOp, landed: LandedTx) {
    if (op.kind === "reserve_fund" || op.kind === "reserve_deploy") {
      return finalizeReserveOp(this.reserveDeps, op, landed, this.now());
    }
    const delta = (account: string) =>
      landed.tokenDeltas.filter((d) => d.account === account).reduce((a, d) => a + d.delta, 0n);
    const ata = (mint: string) => this.deps.chain.masterTokenAccount(mint);
    const details = { ...((op.details ?? {}) as Record<string, unknown>) };
    let amountOut = 0n;
    let burnRow: Prisma.BurnLedgerCreateManyInput | null = null;

    if (op.kind === "claim_curve") {
      amountOut = delta(await ata(op.assetMint));
      details.claimed = { [op.assetMint]: amountOut.toString() };
    } else if (op.kind === "claim_cpmm") {
      const mints = (details.mints as string[] | undefined) ?? [op.assetMint];
      const claimed: Record<string, string> = {};
      for (const m of mints) claimed[m] = delta(await ata(m)).toString();
      details.claimed = claimed;
      amountOut = BigInt(claimed[op.assetMint] ?? "0");
    } else if (op.kind === "buyback") {
      amountOut = delta(await ata(op.tokenMint!));
      details.spentRaw = (-delta(await ata(op.assetMint))).toString();
    } else {
      const burned = -delta(op.target);
      amountOut = burned;
      if (burned !== big(op.amountIn)) {
        details.verifyError = `Δ ATA ${burned} ≠ jumlah burn ${big(op.amountIn)}`;
        this.deps.logger.warn({ opId: op.id, ...details }, "ALERT: burn tidak terverifikasi");
      } else {
        const parent = op.parentOpId
          ? await this.db.economicOp.findUnique({ where: { id: op.parentOpId } })
          : null;
        const spent = parent
          ? ((parent.details as { spentRaw?: string }).spentRaw ?? big(parent.amountIn).toString())
          : "0";
        burnRow = {
          tokenMint: op.tokenMint!,
          amountBurned: dec(burned),
          amountSpent: dec(BigInt(spent)),
          assetMint: parent ? parent.assetMint : op.assetMint,
          source: "buyback",
          buybackSignature: parent?.signature ?? op.signature!,
          burnSignature: op.signature!,
        };
        details.verified = true;
      }
    }

    await this.db.$transaction(async (tx) => {
      const moved = await tx.economicOp.updateMany({
        where: { id: op.id, status: { in: ["signed", "submitted"] } },
        data: {
          status: "confirmed",
          slot: BigInt(landed.slot),
          amountOut: dec(amountOut < 0n ? 0n : amountOut),
          details: details as Prisma.InputJsonValue,
          confirmedAt: this.now(),
          lastError: null,
        },
      });
      // Total burned hanya dari burn terkonfirmasi & terverifikasi; signature unik → tidak dobel.
      if (moved.count === 1 && burnRow) {
        await tx.burnLedger.createMany({ data: [burnRow], skipDuplicates: true });
      }
    });
    this.deps.logger.info(
      { opId: op.id, kind: op.kind, signature: op.signature, amountOut: amountOut.toString() },
      "operasi confirmed",
    );
  }

  tally(res: CycleResult, outcome: OpOutcome) {
    if (outcome === "confirmed") res.confirmed++;
    else if (outcome === "failed") res.failed++;
    else if (outcome === "expired") res.expired++;
  }

  /** Menggerakkan semua operasi aktif jenis tertentu (recovery setelah restart). */
  async driveActive(kinds: EconomicOp["kind"][], res: CycleResult) {
    const ops = await this.db.economicOp.findMany({
      where: { kind: { in: kinds }, status: { in: [...ACTIVE] } },
      orderBy: { createdAt: "asc" },
    });
    for (const op of ops) {
      const outcome = await this.drive(op);
      this.tally(res, outcome);
      if (outcome === "blocked") {
        res.blocked = op.lastError ?? "operasi tertahan";
        return;
      }
    }
  }

  /** Percobaan terakhir untuk target gagal baru-baru ini / terlalu sering → jangan coba dulu. */
  async backoff(kind: EconomicOp["kind"], target: string): Promise<string | null> {
    const recent = await this.db.economicOp.findMany({
      where: { kind, target },
      orderBy: { createdAt: "desc" },
      take: this.cfg.maxAttemptsPerTarget,
    });
    const last = recent[0];
    if (!last || last.status === "confirmed") return null;
    if (
      recent.length >= this.cfg.maxAttemptsPerTarget &&
      recent.every((o) => o.status === "failed" || o.status === "expired")
    ) {
      return `gagal ${recent.length}× berturut-turut; butuh pemeriksaan operator`;
    }
    if (
      (last.status === "failed" || last.status === "expired") &&
      this.now().getTime() - last.updatedAt.getTime() < this.cfg.retryBackoffMs
    ) {
      return `menunggu jeda retry setelah ${last.status}`;
    }
    return null;
  }

  // ---------------------------------------------------------------- fee-processing

  async runFeeProcessing(): Promise<CycleResult> {
    const res = emptyResult();
    await refreshQuoteAssets(this.db, this.deps.cluster);
    await this.driveActive(["claim_curve", "claim_cpmm"], res);
    await this.reconcilePending(res);
    if (res.blocked) return res;

    const tokens = await this.db.token.findMany({
      where: { launchStatus: "live", mint: { not: null } },
    });
    if (this.cfg.feeIntake === "forwarded") {
      await this.intakeForwarded([...new Set(tokens.map((t) => t.quoteMint))], res);
    }
    // Strategi `claim`: vault creator per quote. Strategi `forwarded`: fallback untuk saldo vault
    // yang tersisa (launch lama, scope creator-quote-vault) — vault kosong dilewati.
    const claimable: Array<() => Promise<EconomicOp | null>> = [];

    for (const quoteMint of [...new Set(tokens.map((t) => t.quoteMint))]) {
      const { vault, amount } = await this.deps.chain.curveClaimable(quoteMint);
      const reason = await this.claimBlocker("claim_curve", vault);
      if (reason) {
        res.skipped.push({ target: vault, reason });
        continue;
      }
      if (amount < perQuote(this.cfg.minClaimRaw, quoteMint)) {
        if (amount > 0n)
          res.skipped.push({ target: vault, reason: `di bawah minimum claim (${amount})` });
        continue;
      }
      claimable.push(() =>
        this.createOp({
          kind: "claim_curve",
          target: vault,
          assetMint: quoteMint,
          details: { expectedRaw: amount.toString() },
        }),
      );
    }

    const byMint = new Map(tokens.map((t) => [t.mint!, t]));
    const graduated = await this.db.tokenGraduation.findMany({
      where: { state: "verified", cpmmPool: { not: null } },
    });
    for (const g of graduated) {
      const token = byMint.get(g.tokenMint);
      if (!token) continue;
      const pool = g.cpmmPool!;
      const c = await this.deps.chain.cpmmClaimable(pool);
      if (!c || c.poolCreator !== this.master || !c.enableCreatorFee) continue;
      const reason = await this.claimBlocker("claim_cpmm", pool);
      if (reason) {
        res.skipped.push({ target: pool, reason });
        continue;
      }
      const quoteIsA = c.mintA === token.quoteMint;
      const quoteFees = quoteIsA ? c.feesA : c.feesB;
      const tokenFees = quoteIsA ? c.feesB : c.feesA;
      if (quoteFees < perQuote(this.cfg.minClaimRaw, token.quoteMint) && tokenFees === 0n) {
        if (quoteFees > 0n)
          res.skipped.push({ target: pool, reason: `di bawah minimum claim (${quoteFees})` });
        continue;
      }
      claimable.push(() =>
        this.createOp({
          kind: "claim_cpmm",
          target: pool,
          tokenMint: token.mint,
          assetMint: token.quoteMint,
          details: {
            mints: [c.mintA, c.mintB],
            expected: { [c.mintA]: c.feesA.toString(), [c.mintB]: c.feesB.toString() },
          },
        }),
      );
    }

    for (const make of claimable) {
      const op = await make();
      if (!op) continue;
      res.created++;
      const outcome = await this.drive(op);
      this.tally(res, outcome);
      if (outcome === "blocked") {
        res.blocked = "signer menolak sementara (pause/batas/RPC)";
        break;
      }
    }
    await this.reconcilePending(res);
    return res;
  }

  /**
   * Strategi `forwarded`: deteksi creator fee yang diteruskan StonkFun ke ATA quote master.
   * Tiap kredit sah = satu operasi `fee_forward` confirmed (signature unik → tidak dobel), lalu
   * direkonsiliasi seperti claim. Kredit tak dikenal TIDAK dihitung (alert). Kursor per akun
   * disimpan di worker_heartbeats (`fee-forward:<akun>`).
   */
  private async intakeForwarded(quoteMints: string[], res: CycleResult) {
    for (const quoteMint of quoteMints) {
      const account = await this.deps.chain.masterTokenAccount(quoteMint);
      const name = `fee-forward:${account}`;
      const hb = await this.db.workerHeartbeat.findUnique({ where: { name } });
      const until = ((hb?.details ?? {}) as { cursor?: string }).cursor ?? null;
      const { credits, newest } = await this.deps.chain.inboundCredits(account, {
        until,
        limit: 100,
      });
      for (const c of credits) {
        const k = classifyForwardCredit(c, {
          master: this.master,
          launchlabProgram: this.deps.platform.launchlabProgram,
          forwarders: this.cfg.forwarders,
          quoteMints,
        });
        if (!k.ok) {
          if (k.alert) {
            res.skipped.push({ target: c.signature, reason: k.reason });
            this.deps.logger.warn(
              { signature: c.signature, amount: c.amount.toString(), reason: k.reason },
              "ALERT: kredit masuk tidak diakui sebagai fee StonkFun",
            );
          }
          continue;
        }
        await this.recordForward(account, c, k, res);
      }
      if (newest) await this.saveForwardCursor(name, newest);
    }
    if (quoteMints.includes(WSOL_MINT)) await this.intakeForwardedNative(res);
  }

  /**
   * StonkFun meneruskan creator fee pair SOL sebagai SOL biasa ke wallet master (terlihat on-chain
   * 2026-11-03), bukan WSOL. Tanpa daftar forwarder kursor tidak dimajukan, agar riwayat tetap bisa
   * dibaca setelah alamatnya diisi.
   */
  private async intakeForwardedNative(res: CycleResult) {
    if (this.cfg.forwarders.length === 0) {
      this.deps.logger.warn({}, "ALERT: STONKFUN_FORWARDERS kosong; fee SOL biasa belum dibaca");
      return;
    }
    const name = `fee-forward-native:${this.master}`;
    const hb = await this.db.workerHeartbeat.findUnique({ where: { name } });
    const until = ((hb?.details ?? {}) as { cursor?: string }).cursor ?? null;
    const { credits, cursor } = await this.deps.chain.inboundNativeCredits(this.master, { until });
    for (const c of credits) {
      const k = classifyNativeForward(c, { master: this.master, forwarders: this.cfg.forwarders });
      if (!k.ok) {
        this.deps.logger.info(
          { signature: c.signature, amount: c.amount.toString(), reason: k.reason },
          "SOL masuk tidak dihitung sebagai fee",
        );
        continue;
      }
      await this.recordForward(this.master, c, k, res);
    }
    if (cursor && cursor !== until) await this.saveForwardCursor(name, cursor);
  }

  private async recordForward(
    target: string,
    c: InboundCredit,
    k: { evidence: ForwardEvidence; forwarder: string | null },
    res: CycleResult,
  ) {
    try {
      await this.db.economicOp.create({
        data: {
          kind: "fee_forward",
          status: "confirmed",
          target,
          assetMint: c.mint,
          idempotencyKey: `fee_forward:${c.signature}`,
          signature: c.signature,
          slot: BigInt(c.slot),
          amountOut: dec(c.amount),
          confirmedAt: this.now(),
          details: {
            claimed: { [c.mint]: c.amount.toString() },
            evidence: k.evidence,
            forwarder: k.forwarder,
          } as Prisma.InputJsonValue,
        },
      });
      res.created++;
      res.confirmed++;
    } catch (err) {
      if (!isUniqueViolation(err)) throw err; // sudah tercatat siklus sebelumnya
    }
  }

  private async saveForwardCursor(name: string, cursor: string) {
    const details = { cursor } as Prisma.InputJsonValue;
    await this.db.workerHeartbeat.upsert({
      where: { name },
      create: { name, lastRunAt: this.now(), lastOkAt: this.now(), details },
      update: { lastRunAt: this.now(), lastOkAt: this.now(), details },
    });
  }

  /** Claim baru untuk target hanya setelah claim sebelumnya selesai & direkonsiliasi. */
  private async claimBlocker(kind: "claim_curve" | "claim_cpmm", target: string) {
    const active = await this.db.economicOp.count({
      where: { kind, target, status: { in: [...ACTIVE] } },
    });
    if (active) return "claim sebelumnya masih berjalan";
    const confirmed = await this.db.economicOp.findMany({
      where: { kind, target, status: "confirmed" },
      select: { details: true },
    });
    if (confirmed.some((o) => !isReconciled(o.details)))
      return "claim sebelumnya belum direkonsiliasi";
    return this.backoff(kind, target);
  }

  /** Rekonsiliasi claim confirmed yang belum selesai, berurutan per slot (per target). */
  private async reconcilePending(res: CycleResult) {
    // Filter JSON di JS: `NOT path = true` di SQL melewatkan baris tanpa key (NULL).
    const claims = (
      await this.db.economicOp.findMany({
        where: { kind: { in: [...INTAKE_KINDS] }, status: "confirmed" },
        orderBy: [{ slot: "asc" }, { createdAt: "asc" }],
      })
    ).filter((o) => !isReconciled(o.details));
    const waitingTargets = new Set<string>();
    for (const op of claims) {
      if (waitingTargets.has(op.target)) continue;
      const details = (op.details ?? {}) as Record<string, unknown>;
      const claimed = (details.claimed ?? {}) as Record<string, string>;
      const assets = Object.keys(claimed).length ? Object.keys(claimed) : [op.assetMint];
      const results: Record<string, string> = {};
      let done = true;
      for (const asset of assets) {
        const r = await reconcileClaimAsset(this.db, {
          claimOpId: op.id,
          kind: op.kind as (typeof INTAKE_KINDS)[number],
          tokenMint: op.tokenMint,
          assetMint: asset,
          claimed: BigInt(claimed[asset] ?? "0"),
          claimSlot: op.slot ?? 0n,
          claimSignature: op.signature!,
          ageMs: this.now().getTime() - (op.confirmedAt ?? op.updatedAt).getTime(),
          graceMs: this.cfg.reconcileGraceMs,
        });
        if (r.status === "waiting") {
          done = false;
          res.skipped.push({ target: op.target, reason: r.reason ?? "menunggu rekonsiliasi" });
          break;
        }
        results[asset] = r.status === "already" ? "done" : r.status;
        // Fee diteruskan tanpa fee per trade dibagi menurut volume: normal, bukan selisih.
        const byVolume =
          op.kind === "fee_forward" && r.ledgerRaw === 0n && r.unattributedRaw === 0n;
        if (r.status === "estimated" && !byVolume) {
          this.deps.logger.warn(
            {
              opId: op.id,
              asset,
              claimed: r.claimedRaw.toString(),
              ledger: r.ledgerRaw.toString(),
              difference: r.differenceRaw.toString(),
            },
            "ALERT: selisih claim vs ledger → estimated + correction",
          );
        }
      }
      if (!done) {
        waitingTargets.add(op.target);
        continue;
      }
      await this.db.economicOp.update({
        where: { id: op.id },
        data: {
          details: {
            ...details,
            reconciled: true,
            reconciliation: results,
          } as Prisma.InputJsonValue,
        },
      });
    }
  }

  // ---------------------------------------------------------------- buyback + burn

  async runBuyback(): Promise<CycleResult> {
    const res = emptyResult();
    await refreshQuoteAssets(this.db, this.deps.cluster);
    await this.driveActive(["buyback", "burn"], res);
    if (res.blocked) return res;
    await this.createPendingBurns(res);
    if (res.blocked) return res;
    // Operasi yang sudah berjalan tetap diselesaikan di atas; yang baru ditahan.
    if (!this.spendingEnabled) return res;

    const tokens = await this.db.token.findMany({
      where: { launchStatus: "live", mint: { not: null } },
    });
    const byMint = new Map(tokens.map((t) => [t.mint!, t]));
    for (const b of await buybackBudgets(this.db)) {
      if (b.available <= 0n) continue;
      const token = byMint.get(b.tokenMint);
      if (!token) continue;

      // Fee CPMM yang terpotong dalam token itu sendiri: tidak perlu dibeli, langsung dibakar.
      if (b.assetMint === b.tokenMint) {
        const ata = await this.deps.chain.masterTokenAccount(b.tokenMint);
        const reason = await this.backoff("burn", ata);
        if (reason) {
          res.skipped.push({ target: b.tokenMint, reason });
          continue;
        }
        const op = await this.createOp({
          kind: "burn",
          target: ata,
          tokenMint: b.tokenMint,
          assetMint: b.tokenMint,
          amountIn: b.available,
          details: { reason: "token-denominated creator fee" },
        });
        if (op && (await this.runOp(op, res)) === "blocked") return res;
        continue;
      }

      const min = perQuote(this.cfg.minBuybackRaw, b.assetMint);
      if (b.available < min) {
        res.skipped.push({
          target: b.tokenMint,
          reason: `budget ${b.available} < threshold ${min} (batching)`,
        });
        continue;
      }
      const reason = await this.backoff("buyback", b.tokenMint);
      if (reason) {
        res.skipped.push({ target: b.tokenMint, reason });
        continue;
      }
      const pair = await this.pairOf(token);
      if (!pair) {
        res.skipped.push({ target: b.tokenMint, reason: "pair tidak dikenal" });
        continue;
      }
      const maxTx = perQuote(this.cfg.maxBuybackRawPerTx, b.assetMint);
      const amount = b.available < maxTx ? b.available : maxTx;
      const prep = await this.deps.chain.prepareBuyback({
        mint: b.tokenMint,
        pair,
        amountIn: amount,
        slippageBps: this.cfg.slippageBps,
      });
      if (!prep.ok) {
        res.skipped.push({ target: b.tokenMint, reason: prep.reason });
        continue;
      }
      const q = prep.buyback;
      if (q.route === "cpmm" && this.cfg.graduatedRoute === "jupiter") {
        res.skipped.push({
          target: b.tokenMint,
          reason: "jalur jupiter (mainnet) belum diimplementasikan — Tahap 10",
        });
        continue;
      }
      if (q.priceImpactBps > this.cfg.maxPriceImpactBps) {
        res.skipped.push({
          target: b.tokenMint,
          reason: `dampak harga ${q.priceImpactBps} bps > batas ${this.cfg.maxPriceImpactBps}`,
        });
        continue;
      }
      const op = await this.createOp({
        kind: "buyback",
        target: b.tokenMint,
        tokenMint: b.tokenMint,
        assetMint: b.assetMint,
        amountIn: q.amountIn,
        minOut: q.minOut,
        details: {
          route: q.route,
          expectedOut: q.expectedOut.toString(),
          priceImpactBps: q.priceImpactBps,
          slippageBps: this.cfg.slippageBps,
          budgetAvailable: b.available.toString(),
        },
      });
      if (!op) continue;
      const outcome = await this.runOp(op, res);
      if (outcome === "blocked") return res;
      if (outcome === "confirmed") await this.createPendingBurns(res);
      if (res.blocked) return res;
    }
    return res;
  }

  async runOp(op: EconomicOp, res: CycleResult): Promise<OpOutcome> {
    res.created++;
    const outcome = await this.drive(op);
    this.tally(res, outcome);
    if (outcome === "blocked") res.blocked = "signer menolak sementara (pause/batas/RPC)";
    return outcome;
  }

  /** Buyback confirmed yang belum punya burn aktif/confirmed → burn semua hasilnya. */
  private async createPendingBurns(res: CycleResult) {
    const known = (
      await this.db.token.findMany({ where: { mint: { not: null } }, select: { mint: true } })
    ).map((t) => t.mint!);
    const buybacks = await this.db.economicOp.findMany({
      where: {
        kind: "buyback",
        tokenMint: { in: known },
        status: "confirmed",
        children: { none: { kind: "burn", status: { in: [...ACTIVE, "confirmed"] } } },
      },
      orderBy: { confirmedAt: "asc" },
    });
    for (const parent of buybacks) {
      const amount = big(parent.amountOut);
      if (amount <= 0n) continue;
      const ata = await this.deps.chain.masterTokenAccount(parent.tokenMint!);
      const reason = await this.backoff("burn", ata);
      if (reason) {
        res.skipped.push({ target: ata, reason });
        continue;
      }
      const op = await this.createOp({
        kind: "burn",
        target: ata,
        tokenMint: parent.tokenMint,
        assetMint: parent.tokenMint!,
        amountIn: amount,
        parentOpId: parent.id,
        details: { buybackSignature: parent.signature },
      });
      if (!op) continue;
      if ((await this.runOp(op, res)) === "blocked") return;
    }
  }
}

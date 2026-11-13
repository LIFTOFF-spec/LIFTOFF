/**
 * Launch engine (Tahap 4). Satu `run(jobId)` memajukan job sejauh mungkin lalu berhenti saat
 * final, saat harus menunggu konfirmasi lebih lama, atau saat signer dipause.
 *
 * Jaminan tidak ada launch ganda:
 *  1. Mint keypair diturunkan signer dari jobId → setiap pengiriman ulang memakai mint yang sama.
 *     Transaksi create kedua untuk mint yang sudah ada pasti gagal on-chain.
 *  2. Sebelum membangun ulang, engine memeriksa on-chain apakah mint/pool sudah ada dan apakah
 *     signature lama masih bisa mendarat (blockhash belum kedaluwarsa).
 *  3. Signature dicatat di DB SEBELUM dikirim (write-ahead), jadi crash setelah kirim tidak
 *     pernah "melupakan" transaksi yang mungkin mendarat.
 *  4. Transisi status optimistic (lihat store.ts): dua worker tidak bisa sama-sama maju.
 *
 * Status DB adalah sumber kebenaran; worker yang restart cukup memanggil run() lagi.
 */
import type { Db, Prisma } from "@liftoff/db";
import { saveQuoteAsset } from "@liftoff/db";
import {
  adoptionRequirementViolations,
  isFinalLaunchStatus,
  launchFingerprint,
  pairForToken,
  pairsFor,
  requireLaunchablePair,
  StonkFunUnavailableError,
  type LaunchEngineConfig,
  type LaunchStatus,
  type PairConfig,
  type SolanaCluster,
  type StonkFunAdapter,
  type StonkFunLaunchPricing,
} from "@liftoff/shared";
import type { LaunchChain, Sender, SignerClient, SignatureStatus } from "./ports";
import { SignerClientError } from "./ports";
import {
  loadJob,
  releaseClaims,
  transition,
  TransitionConflict,
  type JobWithRelations,
} from "./store";

export type RunResult =
  | { kind: "final"; status: LaunchStatus }
  /** Belum final; jadwalkan run berikutnya setelah `delayMs`. */
  | { kind: "pending"; status: LaunchStatus; delayMs: number }
  | { kind: "paused"; delayMs: number };

type StepResult = { kind: "continue" } | { kind: "wait"; ms: number } | RunResult;

export interface EngineLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
}

export interface LaunchEngineDeps {
  db: Db;
  chain: LaunchChain;
  signer: SignerClient;
  sender: Sender;
  cluster: SolanaCluster;
  config: LaunchEngineConfig;
  /** Config & pair StonkFun saat ini (Spec §4); dibaca ulang sebelum setiap transaksi create. */
  stonkfun: StonkFunAdapter;
  /** URL publik metadata token (Metaplex JSON) untuk tokenId. */
  metadataUri: (tokenId: string) => string;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  logger?: EngineLogger;
}

const SILENT: EngineLogger = { info: () => undefined, warn: () => undefined };

export class LaunchEngine {
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly log: EngineLogger;

  constructor(private readonly deps: LaunchEngineDeps) {
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.now = deps.now ?? Date.now;
    this.log = deps.logger ?? SILENT;
  }

  private get db() {
    return this.deps.db;
  }

  async run(jobId: string): Promise<RunResult> {
    const deadline = this.now() + this.deps.config.confirmWaitMs;
    for (;;) {
      let step: StepResult;
      try {
        step = await this.step(jobId);
      } catch (err) {
        // Worker lain memajukan job ini lebih dulu: baca ulang dan lanjutkan dari status baru.
        if (err instanceof TransitionConflict) continue;
        throw err;
      }
      if (step.kind === "continue") continue;
      if (step.kind !== "wait") return step;
      if (this.now() + step.ms > deadline) {
        const job = await loadJob(this.db, jobId);
        return { kind: "pending", status: job?.status ?? "queued", delayMs: step.ms };
      }
      await this.sleep(step.ms);
    }
  }

  private pairOf(job: JobWithRelations): PairConfig {
    // Quote baru masuk katalog tepat sebelum tanda tangan; verifikasi on-chain hanya butuh mint & config.
    const { quoteMint: mint, quoteConfigId: configId } = job.token;
    return (
      pairForToken(this.deps.cluster, job.token) ?? {
        id: `sf-${mint}`,
        symbol: "?",
        name: "?",
        configId,
        configIndex: 0,
        mint,
        decimals: 0,
        supported: true,
        referralSupported: false,
        minFundRaisingRaw: "0",
        assumedPriceUsd: 0,
        note: null,
      }
    );
  }

  private async step(jobId: string): Promise<StepResult> {
    const job = await loadJob(this.db, jobId);
    if (!job) throw new Error(`launch job ${jobId} tidak ada`);
    if (isFinalLaunchStatus(job.status)) {
      if (job.status === "failed") await this.refundDeposit(job);
      return { kind: "final", status: job.status };
    }
    switch (job.status) {
      case "validating":
        // API membuat job langsung `queued`; `validating` tidak pernah diproses worker.
        return { kind: "pending", status: job.status, delayMs: this.deps.config.staleAfterMs };
      case "queued":
        return this.submit(job);
      default:
        return this.reconcile(job);
    }
  }

  // ------------------------------------------------------------------ reconcile

  private async reconcile(job: JobWithRelations): Promise<StepResult> {
    const { chain, config } = this.deps;
    const pair = this.pairOf(job);
    const creates = job.transactions.filter((t) => t.type === "create");

    const verification = job.mintAddress
      ? await chain.verifyLaunch({ mint: job.mintAddress, pair })
      : null;
    const statuses = creates.length
      ? await chain.signatureStatuses(creates.map((t) => t.signature))
      : [];
    await this.recordStatuses(creates, statuses);

    const landedIdx = statuses.findIndex(
      (s) =>
        s &&
        s.err === null &&
        (s.confirmationStatus === "confirmed" || s.confirmationStatus === "finalized"),
    );
    const landed = landedIdx >= 0 ? creates[landedIdx]! : null;

    if (verification?.ok) {
      return this.markLive(job, verification.pool, landed?.signature ?? null);
    }
    if (landed || verification?.exists) {
      // Transaksi mendarat (atau ada jejak mint/pool) tetapi mint+pool belum terverifikasi:
      // jangan pernah kirim ulang. Rekonsiliasi memeriksa lagi sampai jelas.
      const reason =
        verification && !verification.ok ? verification.reason : "verification pending";
      if (job.status !== "needs_reconciliation") {
        await this.db.$transaction((tx) =>
          transition(tx, job, job.status, "needs_reconciliation", {
            lastError: `Transaction landed but the mint/pool is not verified yet (${reason}).`,
          }),
        );
        this.log.warn({ jobId: job.id, reason }, "launch butuh rekonsiliasi");
      }
      return { kind: "wait", ms: config.confirmPollMs * 5 };
    }

    if (creates.length === 0) {
      // Belum pernah ada transaksi yang ditandatangani (crash/penolakan sebelum mencatat).
      return this.submit(job);
    }

    const height = await chain.blockHeight();
    const stillLive = creates.some((t, i) => {
      const s = statuses[i];
      if (s?.err) return false; // gagal on-chain: tidak akan mendarat
      if (s?.confirmationStatus === "processed") return true; // tunggu konfirmasi
      return t.lastValidBlockHeight !== null && BigInt(height) <= t.lastValidBlockHeight;
    });
    if (stillLive) {
      if (job.status !== "confirming") {
        await this.db.$transaction((tx) => transition(tx, job, job.status, "confirming"));
      }
      return { kind: "wait", ms: config.confirmPollMs };
    }

    // Semua transaksi sebelumnya terbukti tidak akan mendarat dan mint/pool tidak ada.
    const onchainErr = statuses.find((s) => s?.err)?.err;
    if (job.submissionCount >= config.maxSubmissions) {
      return this.markFailed(
        job,
        `The launch transaction did not land after ${job.submissionCount} attempts` +
          (onchainErr ? ` (last error: ${JSON.stringify(onchainErr)}).` : "."),
      );
    }
    this.log.warn(
      { jobId: job.id, attempt: job.submissionCount },
      "transaksi tidak mendarat, kirim ulang (mint sama)",
    );
    return this.submit(job);
  }

  private async recordStatuses(
    creates: JobWithRelations["transactions"],
    statuses: Array<SignatureStatus | null>,
  ) {
    await Promise.all(
      creates.map((t, i) => {
        const s = statuses[i];
        if (!s) return null;
        const next = s.err ? "failed" : (s.confirmationStatus ?? "processed");
        if (next === t.confirmationStatus) return null;
        return this.db.transaction.update({
          where: { signature: t.signature },
          data: {
            confirmationStatus: next,
            slot: BigInt(s.slot),
            errorCode: s.err ? JSON.stringify(s.err).slice(0, 200) : null,
          },
        });
      }),
    );
  }

  // --------------------------------------------------------------------- submit

  private async submit(job: JobWithRelations): Promise<StepResult> {
    const { config, signer, chain, sender } = this.deps;
    if (job.submissionCount >= config.maxSubmissions) {
      return this.markFailed(
        job,
        `The launch could not be sent after ${job.submissionCount} attempts.`,
      );
    }
    if (job.status !== "submitting") {
      await this.db.$transaction((tx) => transition(tx, job, job.status, "submitting"));
      job = (await loadJob(this.db, job.id))!;
    }

    let mint = job.mintAddress;
    if (!mint) {
      mint = (await signer.deriveMint(job.id)).mint;
      await this.db.launchJob.updateMany({
        where: { id: job.id, mintAddress: null },
        data: { mintAddress: mint },
      });
      const fresh = await loadJob(this.db, job.id);
      if (fresh?.mintAddress !== mint) throw new Error("mintAddress job berubah saat disimpan");
    }

    const registryPair = this.pairOf(job);
    // Pagar terakhir sebelum menandatangani: jangan pernah membangun create untuk mint yang ada.
    const pre = await chain.verifyLaunch({ mint, pair: registryPair });
    if (pre.ok || pre.exists) return { kind: "continue" };

    // Spec §4: config StonkFun & pair dibaca ulang; tidak tersedia / berubah sejak divalidasi →
    // gagal aman (klaim dilepas, deposit dikembalikan) sebelum ada transaksi yang ditandatangani.
    let pair: PairConfig;
    let pricing: StonkFunLaunchPricing;
    try {
      const { stonkfun } = this.deps;
      const [list, launchConfig] = await Promise.all([
        stonkfun.listPairs(),
        stonkfun.activeLaunchConfig(),
      ]);
      const current = await stonkfun.resolvePair(
        requireLaunchablePair(list, {
          configId: job.token.quoteConfigId,
          mint: job.token.quoteMint,
        }),
      );
      if (!current.launchLabReady) {
        return this.markFailed(job, `The launch was stopped safely: ${current.unavailableReason}`);
      }
      pricing = await stonkfun.launchPricing(current);
      // Sidik jari lama (sebelum pricing) tetap diterima untuk job yang sudah antre.
      const fingerprints = [
        launchFingerprint(launchConfig, current, pricing),
        launchFingerprint(launchConfig, current),
      ];
      if (job.configFingerprint && !fingerprints.includes(job.configFingerprint)) {
        return this.markFailed(
          job,
          "The StonkFun launch configuration changed after validation, so this launch was stopped safely. Please launch again.",
        );
      }
      // Syarat adopsi StonkFun (Token-2022 6 desimal, CPMM, raise > 0, platform, curve-rule).
      const violations = adoptionRequirementViolations(pricing, current, {
        requireCurveRule: stonkfun.source === "stonkfun_mainnet",
      });
      if (violations.length) {
        return this.markFailed(
          job,
          `The launch was stopped safely: StonkFun would not adopt it (${violations.join("; ")}).`,
        );
      }
      pair = current;
      // Simbol & desimal pair baru tercatat sebelum transaksi ada, jadi indexer, ledger, dan receipt
      // selalu menemukannya. Pair registri tidak perlu.
      if (!pairsFor(this.deps.cluster).some((p) => p.mint === current.mint)) {
        await saveQuoteAsset(this.db, this.deps.cluster, {
          mint: current.mint,
          symbol: current.symbol,
          name: current.name,
          decimals: current.decimals,
          raiseRaw: pricing.totalFundRaisingB,
        });
      }
    } catch (err) {
      if (!(err instanceof StonkFunUnavailableError) || err.code === "rpc_unavailable") throw err;
      return this.markFailed(job, `The launch was stopped safely: ${err.message}`);
    }

    const built = await chain.buildLaunch({
      mint,
      name: job.token.name,
      symbol: job.token.ticker,
      uri: this.deps.metadataUri(job.tokenId),
      pair,
      pricing,
      tipAccount: await sender.tipAccount(),
    });

    let signed: { signature: string; transaction: string };
    try {
      signed = await signer.sign({
        purpose: "launch",
        jobId: job.id,
        transaction: built.transaction,
      });
    } catch (err) {
      return this.onSignError(job, err, mint, pair);
    }

    // Write-ahead: signature + batas blockhash tercatat sebelum transaksi meninggalkan worker.
    await this.db.$transaction(async (tx) => {
      await tx.transaction.create({
        data: {
          signature: signed.signature,
          jobId: job.id,
          type: "create",
          confirmationStatus: "pending",
          lastValidBlockHeight: BigInt(built.lastValidBlockHeight),
          sendMode: sender.mode,
        },
      });
      await transition(tx, job, "submitting", "confirming", {
        submissionCount: { increment: 1 },
        lastError: null,
      });
    });

    try {
      const res = await sender.send(signed.transaction);
      if (res.bundleId) {
        await this.db.transaction.update({
          where: { signature: signed.signature },
          data: { bundleId: res.bundleId },
        });
        await this.db.launchJob.update({ where: { id: job.id }, data: { bundleId: res.bundleId } });
      }
    } catch (err) {
      // Timeout/jaringan: transaksi mungkin tetap sampai. Rekonsiliasi memutuskan dari signature.
      this.log.warn(
        { jobId: job.id, err: (err as Error).message },
        "pengiriman gagal/timeout; dipantau lewat signature",
      );
    }
    this.log.info({ jobId: job.id, signature: signed.signature }, "transaksi launch dikirim");
    return { kind: "wait", ms: config.confirmPollMs };
  }

  private async onSignError(
    job: JobWithRelations,
    err: unknown,
    mint: string,
    pair: PairConfig,
  ): Promise<StepResult> {
    if (!(err instanceof SignerClientError)) throw err;
    if (err.code === "paused" || err.code === "limit_exceeded") {
      // Belum ada transaksi baru yang ditandatangani → aman kembali ke antrean.
      await this.db.$transaction((tx) =>
        transition(tx, job, "submitting", "queued", {
          lastError:
            err.code === "paused"
              ? "Launches are paused by the operator. Your launch will continue automatically."
              : "The daily launch budget is used up. Your launch will continue automatically.",
        }),
      );
      return { kind: "paused", delayMs: this.deps.config.pausedRetryMs };
    }
    if (err.retryable) throw err; // RPC/jaringan: BullMQ mencoba lagi dengan backoff
    if (err.code === "simulation_failed") {
      // Bisa jadi transaksi sebelumnya baru saja mendarat → cek on-chain sebelum menyerah.
      const v = await this.deps.chain.verifyLaunch({ mint, pair });
      if (v.ok || v.exists) return { kind: "continue" };
    }
    return this.markFailed(job, `The launch was rejected before sending: ${err.message}`);
  }

  // ------------------------------------------------------------------ terminal

  private async markLive(
    job: JobWithRelations,
    pool: string,
    signature: string | null,
  ): Promise<StepResult> {
    await this.db.$transaction(async (tx) => {
      let from = job.status;
      if (from === "submitting") {
        // Pool ditemukan saat pagar pra-kirim (transaksi lama mendarat terlambat).
        await transition(tx, job, from, "confirming");
        job = (await loadJob(tx, job.id))!;
        from = "confirming";
      }
      await transition(tx, job, from, "live", {
        poolAddress: pool,
        lastError: null,
        ...(signature ? { createSignature: signature } : {}),
      });
      // P5: mint baru dipublikasikan setelah mint & pool terverifikasi.
      await tx.token.update({ where: { id: job.tokenId }, data: { mint: job.mintAddress } });
      if (signature) {
        await tx.transaction.update({
          where: { signature },
          data: { confirmationStatus: "confirmed" },
        });
      }
      await tx.launchDeposit.updateMany({
        where: { jobId: job.id, status: "received" },
        data: { status: "kept" },
      });
      await tx.auditEvent.create({
        data: {
          actor: "worker:launch",
          action: "launch.live",
          result: "ok",
          txSignature: signature,
          details: { jobId: job.id, mint: job.mintAddress, pool },
        },
      });
    });
    this.log.info({ jobId: job.id, mint: job.mintAddress, signature }, "launch live");
    return { kind: "final", status: "live" };
  }

  private async markFailed(job: JobWithRelations, reason: string): Promise<StepResult> {
    await this.db.$transaction(async (tx) => {
      await transition(tx, job, job.status, "failed", { lastError: reason });
      await releaseClaims(tx, job.tokenId);
      await tx.launchDeposit.updateMany({
        where: { jobId: job.id, status: "received" },
        data: { status: "refund_pending" },
      });
      await tx.auditEvent.create({
        data: {
          actor: "worker:launch",
          action: "launch.failed",
          result: "failed",
          details: { jobId: job.id, reason } as Prisma.InputJsonValue,
        },
      });
    });
    this.log.warn({ jobId: job.id, reason }, "launch gagal permanen; klaim ticker dilepas");
    const failed = (await loadJob(this.db, job.id))!;
    await this.refundDeposit(failed);
    return { kind: "final", status: "failed" };
  }

  /**
   * Refund deposit (hanya jika LAUNCH_DEPOSIT_ENABLED dan ada deposit). Idempotent: refund yang
   * sudah dikirim dipantau lewat signature-nya, bukan dikirim ulang.
   */
  private async refundDeposit(job: JobWithRelations): Promise<void> {
    const deposit = await this.db.launchDeposit.findUnique({ where: { jobId: job.id } });
    if (!deposit || deposit.status !== "refund_pending") return;
    const { chain, signer, sender } = this.deps;
    if (deposit.refundSignature) {
      const [s] = await chain.signatureStatuses([deposit.refundSignature]);
      if (s && !s.err && s.confirmationStatus !== "processed") {
        await this.db.launchDeposit.update({
          where: { id: deposit.id },
          data: { status: "refunded" },
        });
        return;
      }
      const tx = await this.db.transaction.findUnique({
        where: { signature: deposit.refundSignature },
      });
      const height = await chain.blockHeight();
      if (tx?.lastValidBlockHeight && BigInt(height) <= tx.lastValidBlockHeight) return; // tunggu
    }
    try {
      const built = await chain.buildTransfer({
        to: deposit.payer,
        lamports: BigInt(deposit.lamports.toFixed(0)),
      });
      const signed = await signer.sign({
        purpose: "deposit_refund",
        jobId: job.id,
        transaction: built.transaction,
      });
      await this.db.$transaction([
        this.db.transaction.create({
          data: {
            signature: signed.signature,
            jobId: job.id,
            type: "deposit_refund",
            lastValidBlockHeight: BigInt(built.lastValidBlockHeight),
            sendMode: sender.mode,
          },
        }),
        this.db.launchDeposit.update({
          where: { id: deposit.id },
          data: { refundSignature: signed.signature },
        }),
      ]);
      await sender.send(signed.transaction).catch(() => undefined);
    } catch (err) {
      // Refund dicoba lagi oleh sweeper; launch tetap failed.
      this.log.warn({ jobId: job.id, err: (err as Error).message }, "refund deposit tertunda");
    }
  }
}

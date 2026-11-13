import { createHash } from "node:crypto";
import {
  Prisma,
  type LaunchDeposit as LaunchDepositRow,
  type LaunchJob as LaunchJobRow,
  type Token,
  type Transaction,
} from "@liftoff/db";
import {
  displayTicker,
  idempotencyKeySchema,
  launchInputSchema,
  normalizeTicker,
  pairForToken,
  RATE_LIMITS,
  platformFor,
  uuidSchema,
  type LaunchJob,
  type LaunchRules,
  type LaunchTimelineEntry,
  type ValidateLaunchResponse,
  type ValidationField,
  type ValidationReason,
} from "@liftoff/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../app";
import { checkLaunch } from "../lib/anti-copycat";
import { HttpError } from "../lib/errors";
import { ImageStore } from "../lib/images";
import {
  countWalletLaunches,
  lockWallet,
  walletLimit,
  walletLimitMessage,
} from "../lib/launch-quota";
import { enforceRateLimit, takeGlobalLaunchQuota } from "../lib/rate-limit";
import { formatSol } from "../lib/wallet-check";
import type { SessionUser } from "../lib/session";

const FIELD_OF: Record<string, ValidationField> = {
  name: "name",
  ticker: "ticker",
  description: "description",
  website: "website",
  telegram: "telegram",
  x: "x",
  pairId: "pair",
  imageRef: "image",
};

/** Hasil penolakan dari dalam transaksi DB (klaim unik kalah balapan). */
class LaunchRejected extends Error {
  constructor(readonly reasons: ValidationReason[]) {
    super("launch rejected");
  }
}

/** Signature deposit (base58, 64 byte → 86–88 karakter). */
const depositBodySchema = z.object({
  depositSignature: z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{80,90}$/, "Invalid deposit signature."),
});

export function toLaunchJob(
  job: LaunchJobRow & {
    token: Token;
    transactions?: Transaction[];
    deposit?: LaunchDepositRow | null;
  },
  cluster: AppContext["config"]["cluster"],
): LaunchJob {
  const pair = pairForToken(cluster, job.token);
  const live = job.status === "live";
  const lastTx = job.transactions?.filter((t) => t.type === "create").at(-1);
  return {
    id: job.id,
    tokenId: job.tokenId,
    idempotencyKey: job.idempotencyKey,
    status: job.status,
    // Jumlah transaksi create yang ditandatangani (pengiriman ulang memakai mint yang sama).
    attemptCount: job.submissionCount,
    lastError: job.lastError,
    // P5: mint baru dipublikasikan setelah live.
    mint: live ? job.token.mint : null,
    signature: live ? job.createSignature : null,
    sendMode: (lastTx?.sendMode as LaunchJob["sendMode"] | undefined) ?? null,
    bundleId: job.bundleId,
    token: { name: job.token.name, ticker: job.token.ticker, quoteSymbol: pair?.symbol ?? "?" },
    timeline: (job.timeline as unknown as LaunchTimelineEntry[]) ?? [],
    deposit: job.deposit
      ? {
          lamports: job.deposit.lamports.toFixed(0),
          signature: job.deposit.depositSignature,
          status: job.deposit.status,
          refundSignature: job.deposit.refundSignature,
        }
      : null,
  };
}

function requestHash(input: unknown): string {
  return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

export async function launchRoutes(app: FastifyInstance, ctx: AppContext) {
  const { db, config } = ctx;

  const check = (input: Parameters<typeof checkLaunch>[0], user: SessionUser | null) =>
    checkLaunch(input, {
      db,
      stonkfun: ctx.stonkfun,
      config: config.antiCopycat,
      cluster: config.cluster,
      external: ctx.external,
      images: ctx.images,
      walletChecker: ctx.walletChecker,
      walletRequirements: config.walletRequirements,
      launchLimits: config.launchLimits,
      user,
    });

  // Batas & syarat launch yang berlaku, untuk ditampilkan UI (angka dari config, Aturan #10).
  app.get("/api/launch/rules", async (req): Promise<LaunchRules> => {
    const user = await req.currentUser();
    const limit = user ? walletLimit(config.launchLimits, user.xUserId !== null) : null;
    return {
      perWalletPer24h: config.launchLimits.perWalletPer24h,
      perWalletWithXPer24h: config.launchLimits.perWalletWithXPer24h,
      globalPerDay: config.launchLimits.globalPerDay,
      minBalanceSol: formatSol(config.walletRequirements.minBalanceLamports),
      minWalletAgeDays: config.walletRequirements.minAgeDays,
      deposit: {
        enabled: config.launchDeposit.enabled,
        sol: formatSol(config.launchDeposit.lamports),
        lamports: String(config.launchDeposit.lamports),
        recipient: platformFor(config.cluster).masterWallet,
      },
      remainingForWallet:
        user && limit !== null
          ? Math.max(0, limit - (await countWalletLaunches(db, user.id)))
          : null,
    };
  });

  app.post("/api/launch/validate", async (req): Promise<ValidateLaunchResponse> => {
    const user = await req.currentUser();
    await enforceRateLimit(ctx.kv, "validate", RATE_LIMITS.validate, {
      ip: req.ip,
      userId: user?.id,
      wallet: user?.wallet,
    });
    const body = (req.body ?? {}) as Record<string, unknown>;
    const parsed = launchInputSchema.safeParse(body);
    const shapeReasons: ValidationReason[] = parsed.success
      ? []
      : parsed.error.issues.map((issue) => ({
          field: FIELD_OF[String(issue.path[0])] ?? "name",
          code: "invalid_format",
          message: issue.message,
        }));
    const str = (v: unknown) => (typeof v === "string" ? v : undefined);
    const result = await check(
      {
        name: str(body.name),
        ticker: str(body.ticker),
        pairId: str(body.pairId),
        imageRef: str(body.imageRef) ?? null,
        website: str(body.website),
        telegram: str(body.telegram),
        x: str(body.x),
      },
      user,
    );
    const reasons = [...shapeReasons, ...result.reasons];
    return {
      result: reasons.length ? "rejected" : "ok",
      tickerNormalized: result.tickerNormalized,
      reasons,
      warnings: result.warnings,
      risk: result.risk,
    };
  });

  app.post("/api/launch", async (req, reply) => {
    const user = await req.requireUser();
    const keyParse = idempotencyKeySchema.safeParse(req.headers["idempotency-key"]);
    if (!keyParse.success) {
      throw new HttpError(
        400,
        "idempotency_key_required",
        "Header Idempotency-Key is required (8–128 URL-safe characters).",
      );
    }
    const idempotencyKey = keyParse.data;
    const input = launchInputSchema.parse(req.body ?? {});
    // Deposit launch = biaya launch dibayar creator: signature transfer ke master wallet wajib jika aktif.
    const depositSignature = config.launchDeposit.enabled
      ? depositBodySchema.safeParse(req.body ?? {}).data?.depositSignature
      : undefined;
    if (config.launchDeposit.enabled && !depositSignature) {
      throw new HttpError(
        402,
        "launch_deposit_required",
        `This launch costs ${formatSol(config.launchDeposit.lamports)} SOL, paid by the creator. Send it from your wallet to ${platformFor(config.cluster).masterWallet} and include depositSignature. It is refunded only if the launch fails permanently.`,
      );
    }
    const hash = requestHash(depositSignature ? { input, depositSignature } : input);

    const replay = async () => {
      const existing = await db.launchJob.findUnique({
        where: { idempotencyKey },
        include: { token: true, deposit: true, transactions: { orderBy: { createdAt: "asc" } } },
      });
      if (!existing) return null;
      if (existing.userId !== user.id) {
        throw new HttpError(
          409,
          "idempotency_key_conflict",
          "This Idempotency-Key is already used.",
        );
      }
      if (existing.requestHash !== hash) {
        throw new HttpError(
          422,
          "idempotency_key_reused",
          "This Idempotency-Key was used with a different request body.",
        );
      }
      return toLaunchJob(existing, config.cluster);
    };

    // Replay idempotent tidak memakan rate limit / kuota.
    const earlier = await replay();
    if (earlier) return reply.status(200).send(earlier);

    await enforceRateLimit(ctx.kv, "launch", RATE_LIMITS.launch, {
      ip: req.ip,
      userId: user.id,
      wallet: user.wallet,
    });

    const result = await check(input, user);
    if (result.result === "rejected" || !result.pair || !result.fingerprint) {
      // Request paralel dengan key yang sama bisa tiba setelah request pertama commit: ticker
      // dan akun X-nya kini "terpakai" oleh job kita sendiri → kembalikan job itu.
      const late = await replay();
      if (late) return reply.status(200).send(late);
      throw new HttpError(422, "launch_rejected", "Launch rejected.", result.reasons);
    }
    const pair = result.pair;

    let depositLamports: bigint | null = null;
    if (depositSignature) {
      const dep = await ctx.depositVerifier.verify({
        signature: depositSignature,
        payer: user.wallet,
        recipient: platformFor(config.cluster).masterWallet,
        minLamports: BigInt(config.launchDeposit.lamports),
      });
      if (!dep.ok) throw new HttpError(422, "launch_deposit_invalid", dep.reason);
      depositLamports = dep.lamports;
    }

    const quota: { release: (() => Promise<void>) | null } = { release: null };
    try {
      const job = await db.$transaction(async (tx) => {
        // Serialisasi request dengan Idempotency-Key yang sama.
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`launch:${idempotencyKey}`}, 0))`;
        const again = await tx.launchJob.findUnique({ where: { idempotencyKey } });
        if (again) return { replay: true as const };
        // Kuota diambil di dalam kunci, sehingga retry paralel dengan key yang sama tidak ikut
        // memakan kuota. Kuota wallet: hitung job 24 jam terakhir di bawah advisory lock wallet.
        await lockWallet(tx, user.wallet);
        const hasX = user.xUserId !== null;
        const limit = walletLimit(config.launchLimits, hasX);
        if ((await countWalletLaunches(tx, user.id)) >= limit) {
          throw new HttpError(
            429,
            "wallet_daily_limit",
            walletLimitMessage(limit, hasX, config.launchLimits),
          );
        }
        quota.release = await takeGlobalLaunchQuota(ctx.kv, config.launchLimits.globalPerDay);

        const now = new Date();
        const token = await tx.token.create({
          data: {
            name: input.name,
            ticker: displayTicker(input.ticker),
            tickerNormalized: normalizeTicker(input.ticker),
            imageUrl: input.imageRef ? ImageStore.url(input.imageRef) : null,
            imageHash: result.imageHash,
            description: input.description,
            links: {
              website: input.website || null,
              telegram: input.telegram || null,
              x: result.normalized.xNormalized
                ? `https://x.com/${result.normalized.xNormalized}`
                : null,
            },
            ...result.normalized,
            riskLevel: result.risk!.level,
            riskReport: result.risk as unknown as Prisma.InputJsonValue,
            quoteMint: pair.mint,
            quoteConfigId: pair.configId,
            creatorUserId: user.id,
            launchStatus: "queued",
          },
        });

        // Spec §7: ticker berulang tidak lagi diblok (indikator risiko); klaim tetap dicatat
        // untuk pembanding launch berikutnya.
        await tx.tickerClaim.create({
          data: { tickerNormalized: token.tickerNormalized, tokenId: token.id },
        }); // Akun X opsional; jika tertaut, satu akun X = satu koin aktif (badge verified creator).
        if (user.xUserId) {
          const xClaim = await tx.$queryRaw<Array<{ id: string }>>`
            INSERT INTO "x_account_claims" ("id", "xUserId", "tokenId", "status", "createdAt")
            VALUES (gen_random_uuid(), ${user.xUserId}, ${token.id}::uuid, 'active', now())
            ON CONFLICT ("xUserId") WHERE "status" = 'active' DO NOTHING
            RETURNING "id"`;
          if (xClaim.length === 0) {
            throw new LaunchRejected([
              {
                field: "x_account",
                code: "x_account_has_active_token",
                message: `@${user.xHandle} already has an active coin. One linked X account = one active coin.`,
              },
            ]);
          }
        }

        const created = await tx.launchJob.create({
          data: {
            tokenId: token.id,
            userId: user.id,
            idempotencyKey,
            requestHash: hash,
            status: "queued",
            timeline: [{ status: "queued", at: now.toISOString() }],
            configFingerprint: result.fingerprint,
          },
          include: { token: true, deposit: true, transactions: { orderBy: { createdAt: "asc" } } },
        });
        if (result.appealId) {
          // Banding disetujui hanya berlaku sekali, untuk input identik (inputHash).
          const used = await tx.launchAppeal.updateMany({
            where: { id: result.appealId, userId: user.id, status: "approved" },
            data: { status: "used", usedByJobId: created.id },
          });
          if (used.count !== 1) {
            throw new LaunchRejected([
              {
                field: "name",
                code: "risk_high",
                message: "The approved appeal for this launch was already used.",
              },
            ]);
          }
        }
        if (depositSignature && depositLamports !== null) {
          // Unique depositSignature: satu transfer hanya bisa membiayai satu launch.
          created.deposit = await tx.launchDeposit.create({
            data: {
              jobId: created.id,
              depositSignature,
              payer: user.wallet,
              lamports: new Prisma.Decimal(depositLamports.toString()),
            },
          });
        }
        await tx.auditEvent.create({
          data: {
            actor: `user:${user.id}`,
            action: "launch.job.create",
            result: "ok",
            requestId: req.id,
            details: {
              jobId: created.id,
              ticker: token.ticker,
              pairId: pair.id,
              risk: result.risk!.level,
              appealId: result.appealId,
              configFingerprint: result.fingerprint,
            },
          },
        });
        return { replay: false as const, job: created };
      });

      if (job.replay) {
        const existing = await replay();
        if (existing) return reply.status(200).send(existing);
        throw new HttpError(409, "idempotency_conflict", "Concurrent request with the same key.");
      }
      // Tahap 4: worker (BullMQ `launch`) membangun transaksi, signer menandatangani. Jika enqueue
      // gagal, job tetap `queued` di DB dan sweeper worker mengambilnya.
      await ctx.launchQueue.enqueue(job.job.id).catch((err: unknown) => {
        req.log.warn(
          { err, jobId: job.job.id },
          "enqueue launch gagal; sweeper akan mengambil job",
        );
      });
      return reply.status(201).send(toLaunchJob(job.job, config.cluster));
    } catch (err) {
      await quota.release?.();
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === "P2002" &&
        JSON.stringify(err.meta ?? {}).includes("depositSignature")
      ) {
        throw new HttpError(
          409,
          "launch_deposit_reused",
          "This deposit was already used for another launch.",
        );
      }
      if (err instanceof LaunchRejected) {
        const late = await replay();
        if (late) return reply.status(200).send(late);
        await db.auditEvent
          .create({
            data: {
              actor: `user:${user.id}`,
              action: "launch.job.create",
              result: `rejected:${err.reasons.map((r) => r.code).join(",")}`,
              requestId: req.id,
            },
          })
          .catch(() => undefined);
        throw new HttpError(409, "launch_rejected", "Launch rejected.", err.reasons);
      }
      throw err;
    }
  });

  app.get<{ Params: { id: string } }>("/api/launch/:id", async (req) => {
    const id = uuidSchema.safeParse(req.params.id);
    if (!id.success) throw new HttpError(404, "not_found", "Launch not found.");
    const job = await db.launchJob.findUnique({
      where: { id: id.data },
      include: { token: true, deposit: true, transactions: { orderBy: { createdAt: "asc" } } },
    });
    if (!job) throw new HttpError(404, "not_found", "Launch not found.");
    return toLaunchJob(job, config.cluster);
  });
}

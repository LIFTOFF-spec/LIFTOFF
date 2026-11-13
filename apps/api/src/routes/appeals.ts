/**
 * Banding launch High-risk (Spec §7: "Legitimate projects should have an appeal mechanism").
 *
 *  - Kreator (login SIWS) mengajukan banding untuk input launch yang diblok High.
 *  - Pemilik meninjau di panel admin (/admin), dilindungi allowlist wallet ADMIN_WALLETS + SIWS.
 *  - Disetujui → launch dengan input IDENTIK (inputHash) boleh lewat SEKALI; banding ditandai
 *    `used` di transaksi yang sama dengan pembuatan launch job (routes/launch.ts).
 * Setiap keputusan dicatat di audit_events (append-only).
 */
import { Prisma, type LaunchAppeal as AppealRow, type User } from "@liftoff/db";
import {
  appealInputSchema,
  appealReviewSchema,
  RATE_LIMITS,
  uuidSchema,
  type LaunchAppeal,
  type RiskReport,
  type TokenLinks,
} from "@liftoff/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { envelope, parse, type AppContext } from "../app";
import { checkLaunch } from "../lib/anti-copycat";
import { HttpError } from "../lib/errors";
import { ImageStore } from "../lib/images";
import { enforceRateLimit } from "../lib/rate-limit";

/** Alasan yang tidak bisa dibuka banding (masalah input/pair, bukan risiko). */
const APPEALABLE_REASONS = new Set(["risk_high", "wallet_daily_limit"]);

function toAppeal(row: AppealRow & { user: Pick<User, "wallet"> }): LaunchAppeal {
  const input = row.input as Record<string, string | null>;
  const links: TokenLinks = {
    website: input.website || null,
    telegram: input.telegram || null,
    x: input.x || null,
  };
  return {
    id: row.id,
    status: row.status,
    wallet: row.user.wallet,
    name: String(input.name ?? ""),
    ticker: String(input.ticker ?? ""),
    pairId: String(input.pairId ?? ""),
    links,
    imageUrl: input.imageRef ? ImageStore.url(input.imageRef) : null,
    message: row.message,
    risk: row.risk as unknown as RiskReport,
    reviewNote: row.reviewNote,
    reviewedBy: row.reviewedBy,
    reviewedAt: row.reviewedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

export async function appealRoutes(app: FastifyInstance, ctx: AppContext) {
  const { db, config } = ctx;

  app.post("/api/appeals", async (req, reply) => {
    const user = await req.requireUser();
    await enforceRateLimit(ctx.kv, "validate", RATE_LIMITS.validate, {
      ip: req.ip,
      userId: user.id,
    });
    const { message, ...input } = parse(appealInputSchema, req.body ?? {});
    const result = await checkLaunch(input, {
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
    if (result.risk?.level !== "high") {
      throw new HttpError(
        422,
        "appeal_not_needed",
        "This launch is not blocked as high risk, so no appeal is needed.",
      );
    }
    if (result.risk.appealApproved) {
      throw new HttpError(409, "appeal_already_approved", "An appeal for this launch is approved.");
    }
    const blocking = result.reasons.filter((r) => !APPEALABLE_REASONS.has(r.code));
    if (blocking.length) {
      throw new HttpError(422, "appeal_input_invalid", "Fix these issues first.", blocking);
    }
    try {
      const row = await db.launchAppeal.create({
        data: {
          userId: user.id,
          input: input as unknown as Prisma.InputJsonValue,
          inputHash: result.inputHash,
          risk: result.risk as unknown as Prisma.InputJsonValue,
          message,
        },
        include: { user: { select: { wallet: true } } },
      });
      await db.auditEvent.create({
        data: {
          actor: `user:${user.id}`,
          action: "appeal.create",
          result: "ok",
          requestId: req.id,
          details: { appealId: row.id, score: result.risk.score },
        },
      });
      return reply.status(201).send(toAppeal(row));
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
        throw new HttpError(
          409,
          "appeal_exists",
          "You already have an open appeal for this launch.",
        );
      }
      throw err;
    }
  });

  app.get("/api/appeals/mine", async (req) => {
    const user = await req.requireUser();
    const rows = await db.launchAppeal.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: "desc" },
      take: 50,
      include: { user: { select: { wallet: true } } },
    });
    return envelope(rows.map(toAppeal), "indexer");
  });

  app.get("/api/admin/appeals", async (req) => {
    await req.requireAdmin();
    const { status } = z
      .object({
        status: z.enum(["pending", "approved", "rejected", "used", "all"]).default("pending"),
      })
      .parse(req.query);
    const rows = await db.launchAppeal.findMany({
      where: status === "all" ? {} : { status },
      orderBy: { createdAt: "asc" },
      take: 200,
      include: { user: { select: { wallet: true } } },
    });
    return envelope(rows.map(toAppeal), "indexer");
  });

  app.post<{ Params: { id: string } }>("/api/admin/appeals/:id/review", async (req) => {
    const admin = await req.requireAdmin();
    const id = uuidSchema.safeParse(req.params.id);
    if (!id.success) throw new HttpError(404, "not_found", "Appeal not found.");
    const body = parse(appealReviewSchema, req.body ?? {});
    const updated = await db.$transaction(async (tx) => {
      const res = await tx.launchAppeal.updateMany({
        where: { id: id.data, status: "pending" },
        data: {
          status: body.decision,
          reviewNote: body.note || null,
          reviewedBy: admin.wallet,
          reviewedAt: new Date(),
        },
      });
      if (res.count !== 1) {
        throw new HttpError(409, "appeal_not_pending", "This appeal was already reviewed.");
      }
      await tx.auditEvent.create({
        data: {
          actor: `admin:${admin.wallet}`,
          action: "appeal.review",
          result: body.decision,
          requestId: req.id,
          details: { appealId: id.data, note: body.note },
        },
      });
      return tx.launchAppeal.findUniqueOrThrow({
        where: { id: id.data },
        include: { user: { select: { wallet: true } } },
      });
    });
    return toAppeal(updated);
  });
}

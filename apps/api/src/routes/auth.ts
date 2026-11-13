/**
 * Autentikasi (D9 revisi):
 *  - Identitas utama = wallet lewat Sign-In With Solana (tanda tangan pesan, tanpa transaksi).
 *  - Akun X = OPSIONAL, ditautkan ke wallet yang sudah sign-in (OAuth 2.0 PKCE; atau dev-link
 *    bertanda jelas jika X_CLIENT_ID kosong di luar production).
 */
import { createPublicKey, randomBytes, verify } from "node:crypto";
import {
  base58Decode,
  buildSiwsMessage,
  devLinkSchema,
  RATE_LIMITS,
  siwsNonceSchema,
  siwsVerifySchema,
  type SessionInfo,
  type SiwsChallenge,
  type XLinkMode,
} from "@liftoff/shared";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { AppContext } from "../app";
import { HttpError } from "../lib/errors";
import { enforceRateLimit } from "../lib/rate-limit";
import type { SessionUser } from "../lib/session";
import { buildAuthorizeUrl, createPkce, exchangeCodeForIdentity } from "../lib/x-oauth";

const STATE_TTL_SECONDS = 10 * 60;
const SIWS_TTL_SECONDS = 10 * 60;

/** Hanya path relatif di web LIFTOFF (mencegah open redirect). */
function safeReturnTo(value: unknown): string {
  return typeof value === "string" && /^\/(?!\/)[\w\-./?=&%#]*$/.test(value) ? value : "/";
}

/** Verifikasi tanda tangan ed25519 atas `message` dengan public key wallet (base58). */
export function verifyWalletSignature(wallet: string, message: string, signature: string): boolean {
  try {
    const key = createPublicKey({
      key: {
        kty: "OKP",
        crv: "Ed25519",
        x: Buffer.from(base58Decode(wallet)).toString("base64url"),
      },
      format: "jwk",
    });
    const sig = base58Decode(signature);
    if (sig.length !== 64) return false;
    return verify(null, Buffer.from(message, "utf8"), key, sig);
  } catch {
    return false;
  }
}

function sessionInfo(
  mode: XLinkMode,
  user: SessionUser | null,
  adminWallets: string[] = [],
): SessionInfo {
  return {
    xLinkMode: mode,
    user: user
      ? {
          id: user.id,
          wallet: user.wallet,
          xHandle: user.xHandle,
          xDevLink: user.xUserId?.startsWith("dev:") ?? false,
          isAdmin: adminWallets.includes(user.wallet),
        }
      : null,
  };
}

export async function authRoutes(app: FastifyInstance, ctx: AppContext) {
  const { config, db } = ctx;
  const secureCookie = config.production;
  const xLinkMode: XLinkMode = config.xOAuth ? "x" : config.devXLinkEnabled ? "dev" : "disabled";
  const web = new URL(config.webOrigin);

  const limitAuth = (req: FastifyRequest) =>
    enforceRateLimit(ctx.kv, "auth", RATE_LIMITS.auth, { ip: req.ip });

  app.get("/api/auth/me", async (req) =>
    sessionInfo(xLinkMode, await req.currentUser(), config.adminWallets),
  );

  // ------------------------------------------------------------ SIWS

  app.post("/api/auth/siws/nonce", async (req): Promise<SiwsChallenge> => {
    await limitAuth(req);
    const { wallet } = siwsNonceSchema.parse(req.body ?? {});
    const nonce = randomBytes(16).toString("hex");
    const issuedAt = new Date();
    const expiresAt = new Date(issuedAt.getTime() + SIWS_TTL_SECONDS * 1000);
    const message = buildSiwsMessage({
      domain: web.host,
      wallet,
      uri: web.origin,
      cluster: config.cluster,
      nonce,
      issuedAt: issuedAt.toISOString(),
      expirationTime: expiresAt.toISOString(),
    });
    await ctx.kv.set(`siws:${nonce}`, JSON.stringify({ wallet, message }), SIWS_TTL_SECONDS);
    return { message, expiresAt: expiresAt.toISOString() };
  });

  app.post("/api/auth/siws/verify", async (req, reply) => {
    await limitAuth(req);
    const { wallet, message, signature } = siwsVerifySchema.parse(req.body ?? {});
    const nonce = /^Nonce: ([0-9a-f]{32})$/m.exec(message)?.[1];
    // Nonce sekali pakai: diambil & dihapus sebelum verifikasi (replay ditolak).
    const stored = nonce ? await ctx.kv.take(`siws:${nonce}`) : null;
    const challenge = stored ? (JSON.parse(stored) as { wallet: string; message: string }) : null;
    if (!challenge || challenge.wallet !== wallet || challenge.message !== message) {
      throw new HttpError(401, "siws_invalid_challenge", "Sign-in request expired. Try again.");
    }
    if (!verifyWalletSignature(wallet, message, signature)) {
      throw new HttpError(401, "siws_invalid_signature", "Signature does not match this wallet.");
    }
    const user = await db.user.upsert({ where: { wallet }, update: {}, create: { wallet } });
    await ctx.sessions.create(reply, user.id, secureCookie);
    await db.auditEvent.create({
      data: {
        actor: `user:${user.id}`,
        action: "auth.siws.login",
        result: "ok",
        requestId: req.id,
      },
    });
    return sessionInfo(
      xLinkMode,
      {
        id: user.id,
        wallet: user.wallet,
        xUserId: user.xUserId,
        xHandle: user.xHandle,
      },
      config.adminWallets,
    );
  });

  app.post("/api/auth/logout", async (req, reply) => {
    await ctx.sessions.destroy(req, reply);
    return { ok: true };
  });

  // ------------------------------------------------------------ X (opsional)

  /** Menautkan akun X ke user. Satu akun X hanya boleh tertaut ke satu wallet. */
  async function linkX(user: SessionUser, xUserId: string, xHandle: string, requestId: string) {
    const owner = await db.user.findUnique({ where: { xUserId } });
    if (owner && owner.id !== user.id) {
      throw new HttpError(
        409,
        "x_already_linked",
        `@${xHandle} is already linked to another wallet.`,
      );
    }
    await db.user.update({
      where: { id: user.id },
      data: { xUserId, xHandle, xLinkedAt: new Date() },
    });
    await db.auditEvent.create({
      data: {
        actor: `user:${user.id}`,
        action: xUserId.startsWith("dev:") ? "auth.x.dev_link" : "auth.x.link",
        result: "ok",
        requestId,
      },
    });
  }

  // Mulai OAuth 2.0 (PKCE) untuk MENAUTKAN X ke wallet yang sedang sign-in.
  app.get<{ Querystring: { returnTo?: string } }>("/api/auth/x/login", async (req, reply) => {
    await limitAuth(req);
    const user = await req.requireUser();
    if (!config.xOAuth) {
      throw new HttpError(
        503,
        "x_oauth_not_configured",
        config.devXLinkEnabled
          ? "X login is not configured on this server. Use the DEV link instead."
          : "X login is not configured.",
      );
    }
    const state = randomBytes(24).toString("base64url");
    const pkce = createPkce();
    await ctx.kv.set(
      `oauth:x:${state}`,
      JSON.stringify({
        verifier: pkce.verifier,
        returnTo: safeReturnTo(req.query.returnTo),
        userId: user.id,
      }),
      STATE_TTL_SECONDS,
    );
    return reply.redirect(buildAuthorizeUrl(config.xOAuth, state, pkce.challenge));
  });

  app.get<{ Querystring: { code?: string; state?: string; error?: string } }>(
    "/api/auth/x/callback",
    async (req, reply) => {
      await limitAuth(req);
      const fail = (reason: string) =>
        reply.redirect(`${config.webOrigin}/?x_link_error=${encodeURIComponent(reason)}`);
      if (!config.xOAuth) return fail("not_configured");
      const { code, state, error } = req.query;
      if (error) return fail(error === "access_denied" ? "denied" : "x_error");
      if (!code || !state) return fail("invalid_callback");
      const stored = await ctx.kv.take(`oauth:x:${state}`);
      if (!stored) return fail("expired_state");
      const { verifier, returnTo, userId } = JSON.parse(stored) as {
        verifier: string;
        returnTo: string;
        userId: string;
      };
      // Tautan hanya untuk sesi wallet yang memulai alur ini.
      const user = await req.currentUser();
      if (!user || user.id !== userId) return fail("session_mismatch");

      let identity;
      try {
        identity = await exchangeCodeForIdentity(config.xOAuth, code, verifier, ctx.fetchImpl);
      } catch (err) {
        req.log.warn({ err: (err as Error).message }, "X OAuth exchange failed");
        return fail("exchange_failed");
      }
      try {
        await linkX(user, identity.id, identity.username, req.id);
      } catch (err) {
        if (err instanceof HttpError) return fail(err.code);
        throw err;
      }
      return reply.redirect(`${config.webOrigin}${returnTo}`);
    },
  );

  // Mode DEV: tautan X tanpa OAuth, hanya jika X_CLIENT_ID/SECRET kosong dan bukan production.
  // xUserId berprefiks `dev:` sehingga tidak pernah bertabrakan dengan akun X sungguhan.
  app.post("/api/auth/x/dev-link", async (req) => {
    await limitAuth(req);
    if (!config.devXLinkEnabled) throw new HttpError(404, "not_found", "Not found.");
    const user = await req.requireUser();
    const { handle } = devLinkSchema.parse(req.body ?? {});
    const clean = handle.replace(/^@/, "");
    await linkX(user, `dev:${clean.toLowerCase()}`, clean, req.id);
    return sessionInfo(
      xLinkMode,
      {
        ...user,
        xUserId: `dev:${clean.toLowerCase()}`,
        xHandle: clean,
      },
      config.adminWallets,
    );
  });

  // Melepas tautan X. Klaim "satu akun X = satu koin aktif" tetap tercatat per akun X,
  // jadi melepas lalu menautkan ulang tidak membuka koin aktif kedua.
  app.post("/api/auth/x/unlink", async (req) => {
    const user = await req.requireUser();
    await db.user.update({
      where: { id: user.id },
      data: { xUserId: null, xHandle: null, xLinkedAt: null },
    });
    await db.auditEvent.create({
      data: { actor: `user:${user.id}`, action: "auth.x.unlink", result: "ok", requestId: req.id },
    });
    return sessionInfo(xLinkMode, { ...user, xUserId: null, xHandle: null }, config.adminWallets);
  });
}

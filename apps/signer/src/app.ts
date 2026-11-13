import { timingSafeEqual, createHash } from "node:crypto";
import {
  signerMintRequestSchema,
  signerPauseRequestSchema,
  signerSignRequestSchema,
  type SignerErrorBody,
} from "@liftoff/shared";
import Fastify, { type FastifyInstance } from "fastify";
import { ZodError } from "zod";
import type { SignerConfig, SignerScope } from "./config";
import { SignerError, type SignerService } from "./service";

function tokenMatches(header: string | undefined, expected: string): boolean {
  if (!header?.startsWith("Bearer ")) return false;
  // Bandingkan hash agar panjang sama dan perbandingan waktu-konstan.
  const a = createHash("sha256").update(header.slice(7)).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

/** Cakupan token yang cocok (F12); semua token dibandingkan supaya waktu tidak membocorkan urutan. */
export function scopeOf(
  header: string | undefined,
  tokens: SignerConfig["authTokens"],
): SignerScope | null {
  let scope: SignerScope | null = null;
  for (const t of tokens) if (tokenMatches(header, t.token) && !scope) scope = t.scope;
  return scope;
}

declare module "fastify" {
  interface FastifyRequest {
    signerScope?: SignerScope;
  }
}

export function buildSignerApp(
  service: SignerService,
  config: Pick<SignerConfig, "authTokens">,
  options: { logger?: boolean } = {},
): FastifyInstance {
  const app = Fastify({
    logger: options.logger
      ? { redact: ["req.headers.authorization", "req.body.transaction"] }
      : false,
    bodyLimit: 16 * 1024,
  });

  const fail = (code: SignerErrorBody["error"]["code"], message: string, retryable = false) =>
    new SignerError(code, message, retryable);

  // Semua endpoint selain /health wajib token internal worker → signer.
  app.addHook("onRequest", async (req) => {
    if (req.url === "/health") return;
    const scope = scopeOf(req.headers.authorization, config.authTokens);
    if (!scope) throw fail("unauthorized", "token signer tidak valid");
    req.signerScope = scope;
  });

  app.setErrorHandler((err, req, reply) => {
    const e =
      err instanceof SignerError
        ? err
        : (err as { validation?: unknown }).validation || err instanceof ZodError
          ? fail("invalid_request", (err as Error).message)
          : fail("internal", "internal error", true);
    if (e.code === "internal") req.log.error(err);
    const body: SignerErrorBody = {
      error: {
        code: e.code,
        message: e.message,
        retryable: e.retryable,
        ...(e.details !== undefined ? { details: e.details } : {}),
      },
    };
    return reply.status(e.httpStatus).send(body);
  });

  app.setNotFoundHandler((_req, reply) =>
    reply
      .status(404)
      .send({ error: { code: "invalid_request", message: "not found", retryable: false } }),
  );

  app.get("/health", () => service.health());

  app.post("/v1/launch/mint", async (req) => {
    const body = signerMintRequestSchema.parse(req.body ?? {});
    return service.deriveMint(body.jobId, req.id, req.signerScope);
  });

  app.post("/v1/sign", async (req) => {
    const body = signerSignRequestSchema.parse(req.body ?? {});
    return service.sign(body, req.id, req.signerScope);
  });

  app.post("/v1/pause", async (req) => {
    const body = signerPauseRequestSchema.parse(req.body ?? {});
    return service.setPaused(true, "worker-api", body.reason, req.id);
  });

  return app;
}

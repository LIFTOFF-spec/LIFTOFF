import { RATE_LIMITS, type ImageUploadResponse } from "@liftoff/shared";
import type { FastifyInstance } from "fastify";
import type { AppContext } from "../app";
import { HttpError } from "../lib/errors";
import { IMAGE_CONTENT_TYPES, IMAGE_MAX_BYTES, ImageStore } from "../lib/images";
import { enforceRateLimit } from "../lib/rate-limit";

export async function uploadRoutes(app: FastifyInstance, ctx: AppContext) {
  app.addContentTypeParser(
    IMAGE_CONTENT_TYPES,
    { parseAs: "buffer", bodyLimit: IMAGE_MAX_BYTES },
    (_req, body, done) => done(null, body),
  );

  // Body = byte gambar mentah (Content-Type image/png|jpeg|webp|gif), maks 2 MB.
  app.post("/api/uploads/image", async (req, reply): Promise<ImageUploadResponse> => {
    const user = await req.requireUser();
    await enforceRateLimit(ctx.kv, "upload", RATE_LIMITS.upload, {
      ip: req.ip,
      userId: user.id,
      wallet: user.wallet,
    });
    if (!Buffer.isBuffer(req.body)) {
      throw new HttpError(415, "unsupported_media_type", "Upload a PNG, JPEG, WebP or GIF image.");
    }
    let saved;
    try {
      saved = await ctx.images.save(req.body);
    } catch (err) {
      const tooSmall = (err as Error).message === "image_too_small";
      throw new HttpError(
        422,
        tooSmall ? "image_too_small" : "image_invalid",
        tooSmall ? "Image must be at least 64×64 pixels." : "This file is not a valid image.",
      );
    }
    reply.status(201);
    return { imageRef: saved.ref, imageUrl: ImageStore.url(saved.ref), imageHash: saved.hash };
  });

  app.get<{ Params: { file: string } }>("/api/uploads/:file", async (req, reply) => {
    const m = /^([0-9a-f]{32})\.webp$/.exec(req.params.file);
    const data = m ? await ctx.images.read(m[1]!) : null;
    if (!data) throw new HttpError(404, "not_found", "Not found.");
    return reply
      .header("content-type", "image/webp")
      .header("cache-control", "public, max-age=31536000, immutable")
      .header("x-content-type-options", "nosniff")
      .send(data);
  });
}

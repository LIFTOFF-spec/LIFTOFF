import { uuidSchema } from "@liftoff/shared";
import type { FastifyInstance } from "fastify";
import type { AppContext } from "../app";
import { HttpError } from "../lib/errors";

/**
 * Metadata token (format JSON Metaplex) yang dirujuk URI on-chain saat launch. Tidak memuat
 * alamat mint (P5): hanya nama, simbol, deskripsi, gambar, dan tautan.
 */
export async function metadataRoutes(app: FastifyInstance, ctx: AppContext) {
  app.get<{ Params: { file: string } }>("/api/metadata/:file", async (req, reply) => {
    const id = uuidSchema.safeParse(req.params.file.replace(/\.json$/, ""));
    if (!id.success) throw new HttpError(404, "not_found", "Metadata not found.");
    const token = await ctx.db.token.findUnique({ where: { id: id.data } });
    if (!token || token.launchStatus === "failed") {
      throw new HttpError(404, "not_found", "Metadata not found.");
    }
    const links = (token.links ?? {}) as { website?: string | null; telegram?: string | null };
    const base = ctx.config.publicApiUrl;
    reply.header("cache-control", "public, max-age=300");
    return {
      name: token.name,
      symbol: token.ticker,
      description: token.description,
      image: token.imageUrl ? `${base}${token.imageUrl}` : "",
      ...(links.website ? { external_url: links.website } : {}),
      extensions: {
        ...(links.website ? { website: links.website } : {}),
        ...(links.telegram ? { telegram: links.telegram } : {}),
      },
      createdOn: "LIFTOFF",
    };
  });
}

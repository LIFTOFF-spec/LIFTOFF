/**
 * Katalog quote mint (tabel `quote_assets`) dimuat ke memori proses: `pairForMint`/`pairForToken`
 * bersifat sinkron dan dipakai di banyak serializer. Dibaca paling sering tiap `maxAgeMs`; quote yang
 * belum dikenal memicu baca ulang lewat `resolveTokenPair`.
 */
import {
  pairForToken,
  rememberQuoteAssets,
  type PairConfig,
  type SolanaCluster,
} from "@liftoff/shared";
import type { PrismaClient } from "./generated/prisma/client";

type QuoteDb = Pick<PrismaClient, "quoteAsset">;

const REFRESH_MS = 5_000;
let lastRefresh = Number.NEGATIVE_INFINITY;

export async function refreshQuoteAssets(
  db: QuoteDb,
  cluster: SolanaCluster,
  opts: { force?: boolean } = {},
): Promise<void> {
  if (!opts.force && Date.now() - lastRefresh < REFRESH_MS) return;
  lastRefresh = Date.now();
  rememberQuoteAssets(cluster, await db.quoteAsset.findMany());
}

/** Pair sebuah token; undefined = quote tidak dikenal walau katalog sudah dibaca ulang. */
export async function resolveTokenPair(
  db: QuoteDb,
  cluster: SolanaCluster,
  token: { quoteMint: string; quoteConfigId: string },
): Promise<PairConfig | undefined> {
  const known = pairForToken(cluster, token);
  if (known) return known;
  await refreshQuoteAssets(db, cluster, { force: true });
  return pairForToken(cluster, token);
}

/** Dipanggil worker sesudah pair diverifikasi StonkFun + chain, sebelum launch ditandatangani. */
export async function saveQuoteAsset(
  db: QuoteDb,
  cluster: SolanaCluster,
  asset: { mint: string; symbol: string; name: string; decimals: number; raiseRaw: string | null },
): Promise<void> {
  await db.quoteAsset.upsert({
    where: { mint: asset.mint },
    create: asset,
    update: {
      symbol: asset.symbol,
      name: asset.name,
      decimals: asset.decimals,
      raiseRaw: asset.raiseRaw,
    },
  });
  rememberQuoteAssets(cluster, [asset]);
}

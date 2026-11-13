import type { Db } from "@liftoff/db";
import { rawToDecimal, type Candle } from "@liftoff/shared";

/** Batas candle per respons: cukup untuk chart, dan beban query tetap kecil. */
export const MAX_CANDLES = 500;

export interface CandleRow {
  time: number;
  first: string;
  high: string;
  low: string;
  close: string;
  volumeRaw: string;
  trades: number;
}

/**
 * Baris agregat (urut waktu naik) → candle. `priceQuote` adalah harga SESUDAH trade, jadi harga buka
 * = harga tutup candle sebelumnya; candle pertama memakai harga trade pertamanya.
 */
export function buildCandles(rows: CandleRow[], quoteDecimals: number | null): Candle[] {
  const candles = rows.map((row, i): Candle => {
    const open = rows[i - 1]?.close ?? row.first;
    return {
      time: row.time,
      open,
      high: Number(open) > Number(row.high) ? open : row.high,
      low: Number(open) < Number(row.low) ? open : row.low,
      close: row.close,
      volumeQuote:
        quoteDecimals === null ? null : rawToDecimal(BigInt(row.volumeRaw), quoteDecimals),
      trades: row.trades,
    };
  });
  return candles.slice(-MAX_CANDLES);
}

/** Candle dari trade on-chain terindeks. Satu baris ekstra dibaca untuk harga buka candle tertua. */
export async function loadCandles(
  db: Db,
  mint: string,
  intervalSeconds: number,
  quoteDecimals: number | null,
): Promise<Candle[]> {
  const rows = await db.$queryRaw<CandleRow[]>`
    WITH t AS (
      SELECT
        date_bin(
          make_interval(secs => ${intervalSeconds}::float8),
          COALESCE("blockTime", "createdAt"),
          TIMESTAMPTZ 'epoch'
        ) AS bucket,
        COALESCE("blockTime", "createdAt") AS at,
        "slot", "signature", "priceQuote", "amountQuote"
      FROM "trade_receipts"
      WHERE "tokenMint" = ${mint} AND "priceQuote" IS NOT NULL
    )
    SELECT
      extract(epoch FROM bucket)::float8 AS "time",
      trim_scale((array_agg("priceQuote" ORDER BY at, "slot", "signature"))[1])::text AS "first",
      trim_scale(max("priceQuote"))::text AS "high",
      trim_scale(min("priceQuote"))::text AS "low",
      trim_scale((array_agg("priceQuote" ORDER BY at DESC, "slot" DESC, "signature" DESC))[1])::text AS "close",
      sum("amountQuote")::text AS "volumeRaw",
      count(*)::int AS "trades"
    FROM t
    GROUP BY bucket
    ORDER BY bucket DESC
    LIMIT ${MAX_CANDLES + 1}`;
  return buildCandles(rows.reverse(), quoteDecimals);
}

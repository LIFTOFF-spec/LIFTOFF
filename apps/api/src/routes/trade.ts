import { pendingCreatorFeeEntry, recordTradeReceipt } from "@liftoff/db";
import {
  pairForToken,
  platformFor,
  RATE_LIMITS,
  tradeBuildRequestSchema,
  tradeConfirmRequestSchema,
  tradeQuoteRequestSchema,
  type TradeReceipt,
} from "@liftoff/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { parse, type AppContext } from "../app";
import { HttpError } from "../lib/errors";
import { tradePriceAfter } from "@liftoff/solana/receipt";
import { enforceRateLimit } from "../lib/rate-limit";
import { asHttp, parseReceipt, tokenAccountOf, type TradeTarget } from "../lib/trade";

const confirmSchema = tradeConfirmRequestSchema.extend({
  mint: z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/, "Invalid mint."),
});

/**
 * Trading (Tahap 5): quote, transaksi unsigned + simulasi, dan konfirmasi (fee aktual on-chain +
 * pencatatan creator fee → 80/20 di fee_ledger, Spec §9). Tidak butuh login: pengguna
 * menandatangani sendiri, dan semua yang dicatat dibaca ulang dari chain, bukan dari body request.
 */
export async function tradeRoutes(app: FastifyInstance, ctx: AppContext) {
  const { db, config, kv } = ctx;
  const trade = ctx.trade;

  async function target(mint: string): Promise<TradeTarget> {
    const token = await db.token.findUnique({ where: { mint } });
    if (!token || token.launchStatus !== "live") {
      throw new HttpError(404, "token_not_found", "Token not found or not live yet.");
    }
    const pair = pairForToken(config.cluster, token);
    if (!pair) throw new HttpError(422, "route_unavailable", "This token's pair is not supported.");
    return { mint, pair };
  }

  app.post("/api/trade/quote", async (req) => {
    await enforceRateLimit(kv, "trade", RATE_LIMITS.trade, { ip: req.ip });
    const body = parse(tradeQuoteRequestSchema, req.body);
    const t = await target(body.mint);
    return asHttp(() =>
      trade.quote(t, {
        side: body.side,
        amountIn: BigInt(body.amountIn),
        slippageBps: body.slippageBps,
      }),
    );
  });

  app.post("/api/trade/build", async (req) => {
    const body = parse(tradeBuildRequestSchema, req.body);
    await enforceRateLimit(kv, "trade", RATE_LIMITS.trade, { ip: req.ip, wallet: body.wallet });
    const t = await target(body.mint);
    return asHttp(() =>
      trade.build(t, {
        side: body.side,
        amountIn: BigInt(body.amountIn),
        slippageBps: body.slippageBps,
        wallet: body.wallet,
      }),
    );
  });

  app.post("/api/trade/confirm", async (req): Promise<TradeReceipt> => {
    await enforceRateLimit(kv, "trade", RATE_LIMITS.trade, { ip: req.ip });
    const body = parse(confirmSchema, req.body);
    const t = await target(body.mint);
    const [onChain, pools] = await asHttp(() =>
      Promise.all([trade.read(body.signature), trade.pools(t)]),
    );
    if (!onChain) {
      throw new HttpError(409, "trade_pending", "Transaction is not confirmed yet. Retrying…");
    }
    const referralWallet = config.tradeReferralWallet;
    const { receipt, referralAmount } = parseReceipt(
      onChain,
      t,
      pools,
      referralWallet
        ? { wallet: referralWallet, ata: tokenAccountOf(referralWallet, t.pair.mint) }
        : null,
      platformFor(config.cluster).masterWallet,
    );
    // F4 (Tahap 10): API hanya mencatat receipt; creator fee + alokasi 80/20 di fee_ledger dan
    // kontribusi reserve dicatat indexer (role worker) dari transaksi on-chain yang sama.
    await recordTradeReceipt(db, receipt, t.pair.mint, {
      recordedBy: "api",
      priceQuote: tradePriceAfter(onChain, t.pair.mint, t.pair.decimals),
    });
    const creatorFeeEntry = pendingCreatorFeeEntry(receipt);
    const referralLedgerEntry: TradeReceipt["referralLedgerEntry"] =
      referralAmount > 0n
        ? { amount: referralAmount.toString(), assetMint: t.pair.mint, recorded: "pending" }
        : null;
    return { ...receipt, referralLedgerEntry, creatorFeeEntry };
  });
}

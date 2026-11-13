/**
 * Receipt trade dari event program on-chain — dipakai bersama `POST /api/trade/confirm` (Tahap 5)
 * dan indexer (Tahap 6), sehingga label & atribusi fee identik di kedua jalur.
 *
 * Fee yang benar-benar terpotong dibaca dari event (LaunchLab `TradeEvent` / CPMM `SwapEvent`).
 * Transaksi hanya diterima jika event-nya untuk pool resmi token LIFTOFF ini. Referral hanya
 * diakui bila Δ saldo ATA referral LIFTOFF di transaksi = `share_fee` event.
 */
import {
  CURVE_TARGET,
  priceFromReserves,
  RAYDIUM_RATE_DENOMINATOR,
  type TradeFeeItem,
  type TradeReceipt,
} from "@liftoff/shared";
import type { CpmmSwapEvent, LaunchlabTradeEvent, OnChainTrade } from "./trade";

export type ReceiptCore = Omit<TradeReceipt, "referralLedgerEntry" | "creatorFeeEntry">;

export interface ReceiptTarget {
  mint: string;
  quoteMint: string;
}

export interface ReceiptPools {
  launchPool: string;
  cpmmPool: string | null;
}

export type ReceiptErrorCode = "trade_failed" | "not_liftoff_trade" | "not_a_trade";

export type ReceiptResult =
  | { ok: true; receipt: ReceiptCore; referralAmount: bigint }
  | { ok: false; code: ReceiptErrorCode; message: string };

function rateOf(fee: bigint, base: bigint): number {
  return base > 0n ? Number((fee * BigInt(RAYDIUM_RATE_DENOMINATOR) + base / 2n) / base) : 0;
}

export function buildTradeReceipt(
  trade: OnChainTrade,
  t: ReceiptTarget,
  pools: ReceiptPools,
  referral: { wallet: string; ata: string } | null,
  /** Creator semua pool LIFTOFF (curve & CPMM hasil migrasi) = master wallet. */
  creator: string | null = null,
): ReceiptResult {
  if (trade.failed)
    return { ok: false, code: "trade_failed", message: "This transaction failed on-chain." };
  const quoteMint = t.quoteMint;
  const base = { signature: trade.signature, mint: t.mint, wallet: trade.wallet, slot: trade.slot };

  if (trade.launchlab) {
    const e = trade.launchlab;
    if (e.pool !== pools.launchPool) {
      return {
        ok: false,
        code: "not_liftoff_trade",
        message: "Transaction is not a trade on this token's curve.",
      };
    }
    const side = e.direction === 0 ? "buy" : "sell";
    const totalFee = e.platformFee + e.protocolFee + e.shareFee + e.creatorFee;
    const gross = side === "buy" ? e.amountIn : e.amountOut + totalFee;
    const item = (
      kind: TradeFeeItem["kind"],
      label: string,
      amount: bigint,
      recipient: string | null,
    ) => ({
      kind,
      label,
      rate: rateOf(amount, gross),
      amount: amount.toString(),
      mint: quoteMint,
      recipient,
    });
    const fees: TradeFeeItem[] = [
      item("platform", "StonkFun platform fee", e.platformFee, null),
      item("raydium_protocol", "Raydium protocol fee", e.protocolFee, null),
    ];
    let referralAmount = 0n;
    if (e.shareFee > 0n) {
      const credited = referral
        ? trade.tokenDeltas.find((d) => d.account === referral.ata && d.mint === quoteMint)
        : undefined;
      if (
        referral &&
        credited?.delta === e.shareFee &&
        (credited.owner ?? referral.wallet) === referral.wallet
      ) {
        referralAmount = e.shareFee;
        fees.push(item("referral", "LIFTOFF referral fee", e.shareFee, referral.wallet));
      } else {
        fees.push(item("referral", "Referral fee (not LIFTOFF)", e.shareFee, null));
      }
    }
    if (e.creatorFee > 0n) {
      fees.push(
        item("creator", "Creator fee (80% buyback & burn / 20% reserve)", e.creatorFee, creator),
      );
    }
    return {
      ok: true,
      receipt: {
        ...base,
        route: "launchlab",
        side,
        amountIn: e.amountIn.toString(),
        amountOut: e.amountOut.toString(),
        fees,
      },
      referralAmount,
    };
  }

  if (trade.cpmm) {
    const e = trade.cpmm;
    const mints = new Set([e.inputMint, e.outputMint]);
    if (e.pool !== pools.cpmmPool || !mints.has(t.mint) || !mints.has(quoteMint)) {
      return {
        ok: false,
        code: "not_liftoff_trade",
        message: "Transaction is not a swap on this token's pool.",
      };
    }
    const side = e.inputMint === quoteMint ? "buy" : "sell";
    const fees: TradeFeeItem[] = [
      {
        kind: "raydium_lp",
        label: "Raydium pool fee",
        rate: rateOf(e.tradeFee, e.inputAmount),
        amount: e.tradeFee.toString(),
        mint: e.inputMint,
        recipient: null,
      },
    ];
    if (e.creatorFee > 0n) {
      fees.push({
        kind: "creator",
        label: "Pool creator fee (80% buyback & burn / 20% reserve)",
        rate: rateOf(
          e.creatorFee,
          e.creatorFeeOnInput ? e.inputAmount : e.outputAmount + e.creatorFee,
        ),
        amount: e.creatorFee.toString(),
        mint: e.creatorFeeOnInput ? e.inputMint : e.outputMint,
        recipient: creator,
      });
    }
    return {
      ok: true,
      receipt: {
        ...base,
        route: "cpmm",
        side,
        amountIn: e.inputAmount.toString(),
        amountOut: e.outputAmount.toString(),
        fees,
      },
      referralAmount: 0n,
    };
  }

  return {
    ok: false,
    code: "not_a_trade",
    message: "No LaunchLab or Raydium CPMM trade found in this transaction.",
  };
}

/** Harga spot sesudah trade (quote per token, unit tampilan) dari event trade yang sama. */
export function tradePriceAfter(
  trade: OnChainTrade,
  quoteMint: string,
  quoteDecimals: number,
): string | null {
  const r = trade.launchlab
    ? reservesAfterTrade({ launchlab: trade.launchlab })
    : trade.cpmm
      ? reservesAfterTrade({ cpmm: trade.cpmm, quoteMint })
      : null;
  return r ? priceFromReserves(r.quote, r.base, quoteDecimals, CURVE_TARGET.tokenDecimals) : null;
}
/**
 * Cadangan sesudah trade (satuan terkecil) untuk harga per trade, dari event itu sendiri.
 * CPMM: saldo vault sebelum ± jumlah swap (vault ikut memuat fee protocol/fund/creator yang
 * belum di-claim, jadi ini pendekatan dekat, bukan cadangan bersih pool).
 */
export function reservesAfterTrade(
  e: { launchlab: LaunchlabTradeEvent } | { cpmm: CpmmSwapEvent; quoteMint: string },
): { quote: bigint; base: bigint } {
  if ("launchlab" in e) {
    const l = e.launchlab;
    return { quote: l.virtualQuote + l.realQuoteAfter, base: l.virtualBase - l.realBaseAfter };
  }
  const c = e.cpmm;
  const quoteIn = c.inputMint === e.quoteMint;
  const inAfter = c.inputVaultBefore + c.inputAmount;
  const outAfter = c.outputVaultBefore - c.outputAmount;
  return quoteIn ? { quote: inAfter, base: outAfter } : { quote: outAfter, base: inAfter };
}

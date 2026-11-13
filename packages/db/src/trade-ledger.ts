/**
 * Pencatatan trade + creator fee (Spec §9 langkah 3–5, §13, §20A) dari receipt trade on-chain.
 * Dipakai bersama oleh `POST /api/trade/confirm` (apps/api) dan indexer (apps/worker), sehingga
 * trade di luar UI LIFTOFF masuk ke ledger yang sama tanpa dobel-catat.
 *
 * Creator semua koin LIFTOFF = master wallet (launch authority). Creator fee per trade dibaca dari
 * event program di transaksi itu sendiri (LaunchLab `TradeEvent.creator_fee`, CPMM
 * `SwapEvent.creator_fee`) untuk pool resmi koin tersebut, jadi atribusinya per koin dan
 * `verified`. Catatan Spec §13: dana fisiknya berada di vault creator agregat per quote mint
 * (curve) / di pool CPMM sampai di-claim master wallet; ledger ini adalah alokasi logis per koin.
 *
 * Dalam SATU transaksi DB, idempoten per signature:
 *   trade_receipts (PK signature, skipDuplicates)
 *   received (creator_fee, partial unique index `fee_ledger_received_once`) → allocated_buyback
 *   80% + allocated_reserve 20% → reserve_ledger contribution 20%. Sisa pembulatan masuk buyback
 *   (allocateCreatorFee), jadi jumlah alokasi = fee diterima persis (Spec §13 Accounting Rules).
 */
import { allocateCreatorFee, FEE_CONFIG, type TradeReceipt } from "@liftoff/shared";
import { Prisma } from "./generated/prisma/client";
import type { Db } from "./index";

export type ReceiptCore = Omit<TradeReceipt, "referralLedgerEntry" | "creatorFeeEntry">;

export interface TradeRecordMeta {
  recordedBy?: "api" | "indexer";
  /** Waktu blok on-chain; juga dipakai sebagai createdAt receipt baru (riwayat & volume 24 jam). */
  blockTime?: Date | null;
  /** Harga spot sesudah trade (quote per token). */
  priceQuote?: string | null;
}

type ReceiptTx = Parameters<Parameters<Db["$transaction"]>[0]>[0];

async function insertReceipt(
  tx: ReceiptTx,
  receipt: ReceiptCore,
  quoteMint: string,
  meta: TradeRecordMeta,
) {
  const creator = receipt.fees.find((f) => f.kind === "creator");
  const amount = creator ? BigInt(creator.amount) : 0n;
  const isBuy = receipt.side === "buy";
  const priceQuote = meta.priceQuote ? new Prisma.Decimal(meta.priceQuote) : null;
  const created = await tx.tradeReceipt.createMany({
    data: [
      {
        signature: receipt.signature,
        tokenMint: receipt.mint,
        wallet: receipt.wallet,
        side: receipt.side,
        route: receipt.route,
        quoteMint,
        amountToken: new Prisma.Decimal(isBuy ? receipt.amountOut : receipt.amountIn),
        amountQuote: new Prisma.Decimal(isBuy ? receipt.amountIn : receipt.amountOut),
        creatorFee: new Prisma.Decimal(amount.toString()),
        creatorFeeMint: creator?.mint ?? null,
        slot: BigInt(receipt.slot),
        priceQuote,
        blockTime: meta.blockTime ?? null,
        recordedBy: meta.recordedBy ?? "api",
        ...(meta.blockTime ? { createdAt: meta.blockTime } : {}),
      },
    ],
    skipDuplicates: true,
  });
  if (created.count === 0 && (priceQuote || meta.blockTime)) {
    // Receipt sudah ada (jalur lain lebih dulu): lengkapi harga/waktu blok yang belum terisi.
    if (priceQuote) {
      await tx.tradeReceipt.updateMany({
        where: { signature: receipt.signature, priceQuote: null },
        data: { priceQuote },
      });
    }
    if (meta.blockTime) {
      await tx.tradeReceipt.updateMany({
        where: { signature: receipt.signature, blockTime: null },
        data: { blockTime: meta.blockTime },
      });
    }
  }
}

/**
 * Hanya receipt trade (tanpa ledger). Dipakai `POST /api/trade/confirm` sejak Tahap 10 (F4): role
 * DB API tidak punya hak tulis ledger ekonomi; creator fee & alokasi 80/20 dicatat indexer
 * (worker) lewat `recordTradeAndCreatorFee` dari transaksi on-chain yang sama.
 */
export async function recordTradeReceipt(
  db: Db,
  receipt: ReceiptCore,
  quoteMint: string,
  meta: TradeRecordMeta = {},
): Promise<void> {
  await db.$transaction((tx) => insertReceipt(tx, receipt, quoteMint, meta));
}

/** Creator fee & alokasi 80/20 sebuah receipt tanpa menulis apa pun (status `pending`). */
export function pendingCreatorFeeEntry(receipt: ReceiptCore): TradeReceipt["creatorFeeEntry"] {
  const creator = receipt.fees.find((f) => f.kind === "creator");
  const amount = creator ? BigInt(creator.amount) : 0n;
  if (!creator || amount === 0n) return null;
  const alloc = allocateCreatorFee(amount, FEE_CONFIG.split);
  return {
    amount: amount.toString(),
    assetMint: creator.mint,
    buybackBurn: alloc.buybackBurn.toString(),
    convictionReserve: alloc.convictionReserve.toString(),
    recorded: "pending",
  };
}

export async function recordTradeAndCreatorFee(
  db: Db,
  receipt: ReceiptCore,
  quoteMint: string,
  meta: TradeRecordMeta = {},
): Promise<TradeReceipt["creatorFeeEntry"]> {
  const creator = receipt.fees.find((f) => f.kind === "creator");
  const amount = creator ? BigInt(creator.amount) : 0n;

  return db.$transaction(async (tx) => {
    await insertReceipt(tx, receipt, quoteMint, meta);
    if (!creator || amount === 0n) return null;

    const alloc = allocateCreatorFee(amount, FEE_CONFIG.split);
    const entry = {
      amount: amount.toString(),
      assetMint: creator.mint,
      buybackBurn: alloc.buybackBurn.toString(),
      convictionReserve: alloc.convictionReserve.toString(),
      recorded: "new" as "new" | "existing",
    };
    const inserted = await tx.$queryRaw<Array<{ id: string }>>`
      INSERT INTO "fee_ledger"
        ("id", "sourceSignature", "tokenMint", "amount", "assetMint", "entryType", "source", "attribution", "createdAt")
      VALUES (gen_random_uuid(), ${receipt.signature}, ${receipt.mint}, ${amount.toString()}::numeric,
              ${creator.mint}, 'received', 'creator_fee', 'verified', now())
      ON CONFLICT ("sourceSignature", "source") WHERE "entryType" = 'received' DO NOTHING
      RETURNING "id"`;
    if (inserted.length === 0) return { ...entry, recorded: "existing" as const };

    const base = {
      sourceSignature: receipt.signature,
      tokenMint: receipt.mint,
      assetMint: creator.mint,
      source: "creator_fee" as const,
      attribution: "verified" as const,
      relatedSignature: receipt.signature,
    };
    await tx.feeLedger.createMany({
      data: [
        {
          ...base,
          entryType: "allocated_buyback",
          amount: new Prisma.Decimal(alloc.buybackBurn.toString()),
        },
        {
          ...base,
          entryType: "allocated_reserve",
          amount: new Prisma.Decimal(alloc.convictionReserve.toString()),
        },
      ],
    });
    if (alloc.convictionReserve > 0n) {
      // Reserve per koin, terisolasi logis (Spec §11 Phase 1, Rule 3).
      await tx.reserveLedger.create({
        data: {
          tokenMint: receipt.mint,
          entryType: "contribution",
          amount: new Prisma.Decimal(alloc.convictionReserve.toString()),
          assetMint: creator.mint,
          txSignature: receipt.signature,
        },
      });
    }
    return entry;
  });
}

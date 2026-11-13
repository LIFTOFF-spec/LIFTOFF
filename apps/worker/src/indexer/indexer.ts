/**
 * Indexer pasar on-chain (Tahap 6, Spec §14–17). Polling RPC per pool token LIFTOFF:
 *
 *  1. Riwayat transaksi tiap pool (curve LaunchLab, lalu pool CPMM hasil migrasi) lewat
 *     getSignaturesForAddress dari checkpoint terakhir, diproses dari yang paling lama. Event
 *     trade (LaunchLab `TradeEvent`, CPMM `SwapEvent`) untuk pool resmi token dicatat lewat
 *     `recordTradeAndCreatorFee` — ledger yang sama dengan `POST /api/trade/confirm` — jadi
 *     trade di luar UI LIFTOFF ikut tercatat, termasuk creator fee 80/20, tanpa dobel
 *     (PK signature di trade_receipts + unique index fee_ledger).
 *  2. Checkpoint per alamat (`indexer_checkpoints`) maju setelah tiap signature selesai, jadi
 *     restart / error RPC melanjutkan dari titik terakhir; pemrosesan ulang aman (idempoten).
 *  3. Snapshot pasar (`token_markets`): harga spot, supply mint, progres curve, likuiditas,
 *     holder (getProgramAccounts, disegarkan lebih jarang).
 *  4. Graduation (Spec §14, `evaluateGraduation`): status curve → pool CPMM terverifikasi →
 *     `tokens.graduatedAt` diisi otomatis; reserve monitoring hanya aktif setelah verifikasi.
 */
import { Prisma, recordTradeAndCreatorFee, refreshQuoteAssets, type Db } from "@liftoff/db";
import {
  INDEXER_CONFIG,
  pairForToken,
  priceFromReserves,
  type GraduationCheck,
  type IndexerConfig,
  type SolanaCluster,
} from "@liftoff/shared";
import {
  countHolders,
  lpDistribution,
  UnsupportedTransactionError,
  type CpmmPoolSnapshot,
  type LaunchPoolSnapshot,
  type LpDistribution,
} from "@liftoff/solana/market";
import { raydiumAuthoritiesFor } from "@liftoff/shared";
import { buildTradeReceipt, tradePriceAfter } from "@liftoff/solana/receipt";
import type { ParsedTradeTransaction } from "@liftoff/solana/trade";
import { evaluateGraduation } from "./graduation";
import type { IndexerChain, IndexerLogger } from "./ports";
import { isRpcPressure } from "./throttle";

export interface IndexedToken {
  mint: string;
  quoteMint: string;
  quoteConfigId: string;
  graduatedAt: Date | null;
}

export interface MarketIndexerDeps {
  db: Db;
  chain: IndexerChain;
  cluster: SolanaCluster;
  masterWallet: string;
  config?: IndexerConfig;
  logger: IndexerLogger;
  now?: () => Date;
}

export interface SyncResult {
  processed: number;
  recorded: number;
  /** Masih ada signature tersisa (batas per siklus atau transaksi belum tersedia). */
  pending: boolean;
}

export interface CycleResult {
  tokens: number;
  failed: number;
  recorded: number;
}

export class MarketIndexer {
  private readonly config: IndexerConfig;
  private readonly now: () => Date;

  constructor(private readonly deps: MarketIndexerDeps) {
    this.config = deps.config ?? INDEXER_CONFIG;
    this.now = deps.now ?? (() => new Date());
  }

  /** Satu siklus untuk semua token live. Melempar bila RPC tertekan (pemanggil backoff). */
  async runCycle(): Promise<CycleResult> {
    await refreshQuoteAssets(this.deps.db, this.deps.cluster);
    const tokens = await this.deps.db.token.findMany({
      where: { launchStatus: "live", mint: { not: null } },
      select: { mint: true, quoteMint: true, quoteConfigId: true, graduatedAt: true },
      orderBy: { createdAt: "asc" },
    });
    const result: CycleResult = { tokens: tokens.length, failed: 0, recorded: 0 };
    for (const t of tokens) {
      try {
        result.recorded += await this.indexToken({ ...t, mint: t.mint! });
      } catch (err) {
        if (isRpcPressure(err)) throw err;
        result.failed++;
        this.deps.logger.warn(
          { mint: t.mint, err: (err as Error).message },
          "indexer: token gagal diindeks",
        );
      }
    }
    return result;
  }

  private quoteDecimals(t: IndexedToken): number {
    const pair = pairForToken(this.deps.cluster, t);
    // Tidak menebak desimal: token dicoba lagi di siklus berikutnya (runCycle menangkap per token).
    if (!pair) throw new Error(`quote ${t.quoteMint} belum dikenal`);
    return pair.decimals;
  }

  /** Mengindeks satu token; mengembalikan jumlah trade yang baru dicatat. */
  async indexToken(t: IndexedToken): Promise<number> {
    const { chain } = this.deps;
    const launchPool = chain.launchPoolAddress(t.mint, t.quoteMint);
    const pool = await chain.readLaunchPool(launchPool);
    if (!pool) {
      this.deps.logger.warn({ mint: t.mint, launchPool }, "indexer: pool LaunchLab tidak ada");
      return 0;
    }
    if (pool.creator !== this.deps.masterWallet) {
      // Creator fee pool ini bukan milik master wallet LIFTOFF → jangan dicatat sebagai dana token.
      this.deps.logger.warn(
        { mint: t.mint, creator: pool.creator },
        "indexer: creator pool bukan master wallet, dilewati",
      );
      return 0;
    }
    const cpmmAddress = await chain.cpmmPoolAddress(t.mint, t.quoteMint);
    const pools = { launchPool, cpmmPool: cpmmAddress };
    const ctx = { token: t, pools, quoteDecimals: this.quoteDecimals(t) };

    let recorded = (await this.syncAddress(launchPool, "curve", ctx)).recorded;
    const cpmm = pool.status === 2 ? await chain.readCpmmPool(cpmmAddress) : null;
    if (cpmm) recorded += (await this.syncAddress(cpmmAddress, "cpmm", ctx)).recorded;

    await this.checkGraduation(t, pool, cpmmAddress, cpmm);
    await this.writeSnapshot(t, pool, cpmm, ctx.quoteDecimals);
    return recorded;
  }

  /** Memproses signature baru satu alamat dari checkpoint, yang paling lama dulu. */
  async syncAddress(
    address: string,
    kind: "curve" | "cpmm",
    ctx: {
      token: IndexedToken;
      pools: { launchPool: string; cpmmPool: string };
      quoteDecimals: number;
    },
  ): Promise<SyncResult> {
    const { db, chain } = this.deps;
    const cp = await db.indexerCheckpoint.findUnique({ where: { address } });
    const until = cp?.lastSignature ?? undefined;

    const fresh: Awaited<ReturnType<IndexerChain["signatures"]>> = [];
    let before: string | undefined;
    for (;;) {
      const page = await chain.signatures(address, {
        limit: this.config.signaturePageLimit,
        ...(until ? { until } : {}),
        ...(before ? { before } : {}),
      });
      fresh.push(...page);
      if (page.length < this.config.signaturePageLimit) break;
      before = page[page.length - 1]!.signature;
    }
    const ordered = fresh.reverse();
    const batch = ordered.slice(0, this.config.maxTransactionsPerCycle);
    const result: SyncResult = {
      processed: 0,
      recorded: 0,
      pending: ordered.length > batch.length,
    };

    for (const s of batch) {
      if (!s.failed) {
        let tx: ParsedTradeTransaction | null = null;
        let skipped = false;
        try {
          tx = await chain.transaction(s.signature);
        } catch (err) {
          if (!(err instanceof UnsupportedTransactionError)) {
            await this.markError(address, ctx.token.mint, kind, err);
            throw err;
          }
          // Versi transaksi tidak didukung client: dicatat di audit agar bisa ditinjau, lalu lanjut.
          skipped = true;
          await db.auditEvent.create({
            data: {
              actor: "indexer",
              action: "indexer.tx_unsupported",
              result: "skipped",
              txSignature: s.signature,
              details: { address, kind, reason: err.message },
            },
          });
          this.deps.logger.warn({ signature: s.signature }, "indexer: transaksi dilewati");
        }
        if (tx === null && !skipped) {
          // Belum tersedia di RPC: berhenti di sini, checkpoint tidak maju.
          result.pending = true;
          break;
        }
        if (tx && (await this.ingest(tx, kind, ctx))) result.recorded++;
      }
      await db.indexerCheckpoint.upsert({
        where: { address },
        create: {
          address,
          tokenMint: ctx.token.mint,
          kind,
          lastSignature: s.signature,
          lastSlot: BigInt(s.slot),
          processed: 1,
        },
        update: {
          lastSignature: s.signature,
          lastSlot: BigInt(s.slot),
          processed: { increment: 1 },
          errorCount: 0,
          lastError: null,
        },
      });
      result.processed++;
    }
    if (batch.length === 0 && !cp) {
      // Alamat tanpa riwayat: tetap buat checkpoint agar status indexer terlihat.
      await db.indexerCheckpoint.create({
        data: { address, tokenMint: ctx.token.mint, kind },
      });
    }
    return result;
  }

  private async markError(address: string, mint: string, kind: string, err: unknown) {
    const lastError = ((err as Error).message ?? String(err)).slice(0, 500);
    await this.deps.db.indexerCheckpoint.upsert({
      where: { address },
      create: { address, tokenMint: mint, kind, errorCount: 1, lastError },
      update: { errorCount: { increment: 1 }, lastError },
    });
  }

  /** Mencatat trade dari transaksi bila memuat event untuk pool resmi token ini. */
  private async ingest(
    tx: ParsedTradeTransaction,
    kind: "curve" | "cpmm",
    ctx: {
      token: IndexedToken;
      pools: { launchPool: string; cpmmPool: string };
      quoteDecimals: number;
    },
  ): Promise<boolean> {
    if (tx.failed) return false;
    const { token, pools } = ctx;
    const curveEvents =
      kind === "curve" ? tx.launchlabEvents.filter((e) => e.pool === pools.launchPool) : [];
    const swapEvents =
      kind === "cpmm" ? tx.cpmmEvents.filter((e) => e.pool === pools.cpmmPool) : [];
    if (curveEvents.length + swapEvents.length === 0) return false; // create, migrasi, dll.

    const trade = { ...tx, launchlab: curveEvents[0] ?? null, cpmm: swapEvents[0] ?? null };
    const r = buildTradeReceipt(
      trade,
      { mint: token.mint, quoteMint: token.quoteMint },
      pools,
      null,
      this.deps.masterWallet,
    );
    if (!r.ok) {
      this.deps.logger.warn(
        { signature: tx.signature, code: r.code },
        "indexer: bukan trade token",
      );
      return false;
    }
    const events = curveEvents.length + swapEvents.length;
    if (events > 1) {
      // Satu receipt per signature: jumlah dari event pertama, tetapi creator fee SEMUA event
      // dijumlahkan supaya dana token tidak hilang dari ledger.
      const extra = [...curveEvents.slice(1), ...swapEvents.slice(1)].reduce(
        (acc, e) => acc + e.creatorFee,
        0n,
      );
      const creator = r.receipt.fees.find((f) => f.kind === "creator");
      if (creator) creator.amount = (BigInt(creator.amount) + extra).toString();
      this.deps.logger.warn(
        { signature: tx.signature, events },
        "indexer: beberapa trade dalam satu transaksi, creator fee dijumlahkan",
      );
    }
    const entry = await recordTradeAndCreatorFee(this.deps.db, r.receipt, token.quoteMint, {
      recordedBy: "indexer",
      blockTime: tx.blockTime ? new Date(tx.blockTime * 1000) : null,
      priceQuote: tradePriceAfter(trade, token.quoteMint, ctx.quoteDecimals),
    });
    return entry === null || entry.recorded === "new";
  }

  private async checkGraduation(
    t: IndexedToken,
    pool: LaunchPoolSnapshot,
    cpmmAddress: string,
    cpmm: CpmmPoolSnapshot | null,
  ) {
    const { db, chain } = this.deps;
    const existing = await db.tokenGraduation.findUnique({ where: { tokenMint: t.mint } });
    const now = this.now();
    if (pool.status === 0 && !existing) return;
    // Setelah terverifikasi, pemeriksaan ulang (LP berubah karena penyedia lain) cukup berkala.
    if (
      existing?.state === "verified" &&
      now.getTime() - existing.checkedAt.getTime() < this.config.holdersRefreshMs
    ) {
      return;
    }

    let migration = existing?.migrateSignature
      ? {
          signature: existing.migrateSignature,
          launchlabInvoked: true,
          touchesCurve: true,
          blockTime: existing.migratedAt,
        }
      : null;
    let lp: LpDistribution | null = null;
    if (cpmm) {
      migration ??= await this.findMigration(cpmmAddress, pool.address);
      const [supplies, accounts] = await Promise.all([
        chain.mintSupplies([cpmm.mintLp]),
        chain.tokenAccounts(cpmm.mintLp),
      ]);
      const supply = supplies.get(cpmm.mintLp);
      if (supply !== null && supply !== undefined) {
        lp = lpDistribution(
          cpmm.lpAmount,
          supply,
          accounts,
          raydiumAuthoritiesFor(this.deps.cluster).lockCpmm,
        );
      }
    }
    const result = evaluateGraduation({
      mint: t.mint,
      quoteMint: t.quoteMint,
      launchPool: pool,
      cpmmAddress,
      cpmm,
      expectedCpConfigId: await chain.migrationConfigId(),
      masterWallet: this.deps.masterWallet,
      migration,
      lp,
      nowSec: Math.floor(now.getTime() / 1000),
    });
    let state = result.state;
    let checks: GraduationCheck[] = result.checks;
    if (existing?.state === "verified" && state === "failed") {
      const failedIds = checks.filter((c) => !c.ok).map((c) => c.id);
      if (failedIds.every((id) => id === "lp_state" || id === "add_liquidity")) {
        // LP bebas baru (penyedia lain menambah likuiditas) tidak membatalkan verifikasi pool.
        state = "verified";
        checks = checks.map((c) =>
          c.id === "lp_state" ? { ...c, detail: `${c.detail} (changed after verification)` } : c,
        );
      }
    }
    const verifiedNow = state === "verified" && existing?.state !== "verified";
    const migratedAt = migration?.blockTime ?? null;
    const data = {
      state,
      launchPool: pool.address,
      cpmmPool: cpmm?.address ?? null,
      migrateSignature: migration?.signature ?? null,
      migratedAt,
      lpMint: cpmm?.mintLp ?? null,
      lpTotalRaw: lp ? new Prisma.Decimal(lp.total.toString()) : null,
      lpBurnedRaw: lp ? new Prisma.Decimal(lp.burned.toString()) : null,
      lpLockedRaw: lp ? new Prisma.Decimal(lp.locked.toString()) : null,
      lpFreeRaw: lp ? new Prisma.Decimal(lp.free.toString()) : null,
      addLiquiditySupported: result.addLiquiditySupported,
      reserveMonitoringActive: state === "verified" && result.addLiquiditySupported,
      checks: checks as unknown as Prisma.InputJsonValue,
      checkedAt: now,
      ...(verifiedNow ? { verifiedAt: now } : {}),
    };
    await db.tokenGraduation.upsert({
      where: { tokenMint: t.mint },
      create: { tokenMint: t.mint, ...data },
      update: data,
    });
    if (state === existing?.state) return;

    await db.auditEvent.create({
      data: {
        actor: "indexer",
        action: "indexer.graduation",
        result: state,
        txSignature: migration?.signature ?? null,
        details: {
          mint: t.mint,
          cpmmPool: cpmm?.address ?? null,
          checks,
        } as unknown as Prisma.InputJsonValue,
      },
    });
    if (verifiedNow && !t.graduatedAt) {
      // Token pindah ke Graduated otomatis (perbaikan Tahap 5: status DB tidak ikut berubah).
      await db.token.updateMany({
        where: { mint: t.mint, graduatedAt: null },
        data: { graduatedAt: migratedAt ?? now },
      });
    }
    this.deps.logger.info(
      { mint: t.mint, state, cpmmPool: cpmm?.address ?? null },
      "indexer: status graduation berubah",
    );
  }

  /** Transaksi pembuat pool CPMM = signature tertua pool; harus migrasi LaunchLab dari curve ini. */
  private async findMigration(cpmmAddress: string, launchPool: string) {
    const { chain } = this.deps;
    let before: string | undefined;
    let oldest: { signature: string; blockTime: number | null } | null = null;
    for (;;) {
      const page = await chain.signatures(cpmmAddress, {
        limit: this.config.signaturePageLimit,
        ...(before ? { before } : {}),
      });
      if (page.length > 0) oldest = page[page.length - 1]!;
      if (page.length < this.config.signaturePageLimit) break;
      before = page[page.length - 1]!.signature;
    }
    if (!oldest) return null;
    const tx = await chain.transaction(oldest.signature).catch((err: unknown) => {
      if (err instanceof UnsupportedTransactionError) return null;
      throw err;
    });
    if (!tx) return null;
    return {
      signature: oldest.signature,
      launchlabInvoked: tx.accountKeys.includes(chain.programs.launchlab),
      touchesCurve: tx.accountKeys.includes(launchPool),
      blockTime: tx.blockTime ? new Date(tx.blockTime * 1000) : null,
    };
  }

  private async writeSnapshot(
    t: IndexedToken,
    pool: LaunchPoolSnapshot,
    cpmm: CpmmPoolSnapshot | null,
    quoteDecimals: number,
  ) {
    const { db, chain } = this.deps;
    const now = this.now();
    const supply = (await chain.mintSupplies([t.mint])).get(t.mint) ?? pool.supply;

    let price: string | null;
    let liquidity: bigint;
    if (cpmm) {
      const tokenIsA = cpmm.mintA === t.mint;
      const tokenReserve = tokenIsA ? cpmm.reserveA : cpmm.reserveB;
      const quoteReserve = tokenIsA ? cpmm.reserveB : cpmm.reserveA;
      price = priceFromReserves(quoteReserve, tokenReserve, quoteDecimals, pool.mintDecimalsA);
      liquidity = quoteReserve;
    } else {
      // Harga curve constant-product LaunchLab: (virtualB + realB) / (virtualA − realA).
      price = priceFromReserves(
        pool.virtualB + pool.realB,
        pool.virtualA - pool.realA,
        quoteDecimals,
        pool.mintDecimalsA,
      );
      liquidity = pool.realB;
    }

    const existing = await db.tokenMarket.findUnique({ where: { tokenMint: t.mint } });
    let holders = existing?.holders ?? null;
    let holdersAt = existing?.holdersAt ?? null;
    if (!holdersAt || now.getTime() - holdersAt.getTime() >= this.config.holdersRefreshMs) {
      const auth = raydiumAuthoritiesFor(this.deps.cluster);
      holders = countHolders(await chain.tokenAccounts(t.mint), [auth.launchlab, auth.cpmm]);
      holdersAt = now;
    }
    const data = {
      route: cpmm
        ? ("cpmm" as const)
        : pool.status === 0
          ? ("launchlab" as const)
          : ("migrating" as const),
      launchPool: pool.address,
      cpmmPool: cpmm?.address ?? null,
      curveStatus: pool.status,
      priceQuote: price ? new Prisma.Decimal(price) : null,
      supplyRaw: new Prisma.Decimal(supply.toString()),
      curveRaisedRaw: new Prisma.Decimal(pool.realB.toString()),
      curveTargetRaw: new Prisma.Decimal(pool.totalFundRaisingB.toString()),
      liquidityQuoteRaw: new Prisma.Decimal(liquidity.toString()),
      holders,
      holdersAt,
      indexedAt: now,
    };
    await db.tokenMarket.upsert({
      where: { tokenMint: t.mint },
      create: { tokenMint: t.mint, ...data },
      update: data,
    });
  }
}

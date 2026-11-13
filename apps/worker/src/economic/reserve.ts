/**
 * Conviction Reserve Worker (Tahap 8, Spec §11 Phase 1–5, §12, §14, §20C).
 *
 * Setiap siklus:
 *  1. recovery: operasi reserve_fund / reserve_deploy yang masih aktif digerakkan dulu (restart
 *     di tengah deploy mengirim ulang transaksi bertanda tangan yang SAMA, tidak membangun baru);
 *  2. kustodi (Phase 1): reserve token yang sudah di-claim & masih di ATA quote master dipindah ke
 *     akun kustodi token itu (batching ≥ `minFundRaw`);
 *  3. liquidity monitoring (Phase 2) untuk token graduated dengan pool terverifikasi saja (§14):
 *     likuiditas & depth pool, estimasi price impact, perubahan volume, saldo reserve, status
 *     graduation → `evaluateReserveDeployment` (Spec §12) → reserve_decisions (append-only).
 *     Di mainnet nilai USD memakai harga SOL/USD terverifikasi (sol-price.ts); tanpa itu nilainya
 *     tidak diketahui dan deployment TIDAK berjalan (gagal tertutup);
 *  4. deployment (Phase 3–4) bila diizinkan: ≤ 25% saldo kustodi token itu, swap separuh ke token,
 *     add-liquidity ke pool CPMM token itu, LP dibakar di transaksi yang sama.
 * Reserve token yang belum graduate tidak pernah disentuh selain dipindah ke kustodinya sendiri.
 * Tidak ada target harga / market cap (Spec §12 Critical Requirement, Rule 5).
 */
import {
  Prisma,
  refreshQuoteAssets,
  reserveCustody,
  resolveTokenPair,
  type Db,
  type ReserveCustody,
} from "@liftoff/db";
import {
  BPS_DENOMINATOR,
  evaluateReserveDeployment,
  perQuote,
  WSOL_MINT,
  type PairConfig,
  type PerQuoteRaw,
  type PlatformAddresses,
  type QuotePriceBook,
  type ReserveConfig,
  type SolanaCluster,
  type SolPriceIssue,
  type SolPriceReader,
} from "@liftoff/shared";
import type { ReservePoolMetrics } from "@liftoff/solana/reserve";
import { emptyResult, type CycleResult, type EconomicEngine } from "./engine";
import type { EconomicChain, EconomicLogger } from "./ports";

export interface ReserveWorkerSettings {
  config: ReserveConfig;
  intervalMs: number;
  /** Reserve di ATA master minimum sebelum dipindah ke kustodi (biaya 5.000 lamport per transfer). */
  minFundRaw: PerQuoteRaw;
}

export interface ReserveWorkerDeps {
  db: Db;
  engine: EconomicEngine;
  chain: EconomicChain;
  cluster: SolanaCluster;
  platform: PlatformAddresses;
  settings: ReserveWorkerSettings;
  /** Harga SOL/USD mainnet. Tanpa ini mainnet tidak pernah deploy. Tidak dipakai di devnet. */
  solPrice?: Pick<SolPriceReader, "read"> | null;
  /** Harga quote selain SOL. Tanpa ini pair non-SOL menabung tanpa pernah deploy. */
  quotePrices?: Pick<QuotePriceBook, "read"> | null;
  logger: EconomicLogger;
  now?: () => Date;
}

/** Metrik liquidity monitoring (Spec §11 Phase 2) yang disimpan di reserve_decisions. */
export interface ReserveMonitoringSnapshot {
  graduationState: string;
  pool: string | null;
  poolStatus: number | null;
  poolQuoteRaw: string | null;
  poolTokenRaw: string | null;
  /** null = harga tidak terverifikasi (bukan 0: nilainya tidak diketahui). */
  poolLiquidityUsd: number | null;
  depth2PctQuoteRaw: string | null;
  spotPrice: number | null;
  priceSource: "pool_onchain";
  quoteUsd: number | null;
  quoteUsdSource: "assumed_pair_price" | "stonkfun_jupiter";
  /** Bukti harga saat keputusan (mainnet). */
  quoteUsdObservedAt: string | null;
  quoteUsdDeviationBps: number | null;
  quoteUsdIssues: SolPriceIssue[];
  oneHourMoveBps: number;
  volume24hRaw: string;
  volumePrev24hRaw: string;
  volumeChangeBps: number | null;
  reserveBalanceRaw: string;
  reserveInVaultRaw: string;
  reserveBalanceUsd: number | null;
  deployQuoteRaw: string;
  simulatedPriceImpactBps: number;
  lastDeployAt: string | null;
}

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const units = (raw: bigint, decimals: number) => Number(raw) / 10 ** decimals;

/** Harga quote untuk satu keputusan. `usd` null = tidak terverifikasi → deployment ditahan. */
interface QuotePrice {
  usd: number | null;
  ageSeconds: number | null;
  source: ReserveMonitoringSnapshot["quoteUsdSource"];
  observedAt: string | null;
  deviationBps: number | null;
  issues: SolPriceIssue[];
}

export class ReserveWorker {
  constructor(private readonly deps: ReserveWorkerDeps) {}

  private get db() {
    return this.deps.db;
  }
  private get cfg() {
    return this.deps.settings.config;
  }
  private now() {
    return this.deps.now?.() ?? new Date();
  }
  private get master() {
    return this.deps.platform.masterWallet;
  }

  private async pairOf(token: {
    quoteMint: string;
    quoteConfigId: string;
  }): Promise<PairConfig | null> {
    return (await resolveTokenPair(this.db, this.deps.cluster, token)) ?? null;
  }

  private async quotePrice(
    token: { quoteMint: string },
    pair: PairConfig | null,
  ): Promise<QuotePrice> {
    if (this.deps.cluster !== "mainnet-beta") {
      return {
        usd: pair?.assumedPriceUsd ?? 0,
        ageSeconds: 0,
        source: "assumed_pair_price",
        observedAt: null,
        deviationBps: null,
        issues: [],
      };
    }
    const held = (issues: SolPriceIssue[], deviationBps: number | null = null): QuotePrice => ({
      usd: null,
      ageSeconds: null,
      source: "stonkfun_jupiter",
      observedAt: null,
      deviationBps,
      issues,
    });
    const reading =
      token.quoteMint === WSOL_MINT
        ? this.deps.solPrice?.read()
        : this.deps.quotePrices?.read(token.quoteMint);
    const p = reading ? await reading.catch(() => null) : null;
    if (!p) return held(["stonkfun_unreadable", "jupiter_unreadable"]);
    if (p.status !== "verified" || p.usd === null) return held(p.issues, p.deviationBps);
    return {
      usd: p.usd,
      ageSeconds: p.ageSeconds,
      source: "stonkfun_jupiter",
      observedAt: p.observedAt,
      deviationBps: p.deviationBps,
      issues: [],
    };
  }

  async run(): Promise<CycleResult> {
    const res = emptyResult();
    const { engine } = this.deps;
    await refreshQuoteAssets(this.db, this.deps.cluster);
    await engine.driveActive(["reserve_fund", "reserve_deploy"], res);
    if (res.blocked) return res;
    // Operasi yang sudah berjalan tetap diselesaikan di atas; yang baru ditahan.
    if (!engine.spendingEnabled) return res;

    const tokens = await this.db.token.findMany({
      where: { launchStatus: "live", mint: { not: null } },
    });
    const byMint = new Map(tokens.map((t) => [t.mint!, t]));

    // ---- Phase 1: reserve ke kustodi per token
    for (const pos of await reserveCustody(this.db)) {
      const token = byMint.get(pos.tokenMint);
      if (!token || pos.assetMint !== token.quoteMint) continue;
      await this.ensureVault(pos.tokenMint, token.quoteMint);
      if (pos.inMaster <= 0n) continue;
      const min = perQuote(this.deps.settings.minFundRaw, pos.assetMint);
      if (pos.inMaster < min) {
        res.skipped.push({
          target: pos.tokenMint,
          reason: `reserve di ATA master ${pos.inMaster} < minimum pindah ${min} (batching)`,
        });
        continue;
      }
      const vault = await this.deps.chain.reserveVault(pos.tokenMint, pos.assetMint);
      const reason = await engine.backoff("reserve_fund", vault.quoteAccount);
      if (reason) {
        res.skipped.push({ target: pos.tokenMint, reason });
        continue;
      }
      const op = await engine.createOp({
        kind: "reserve_fund",
        target: vault.quoteAccount,
        tokenMint: pos.tokenMint,
        assetMint: pos.assetMint,
        amountIn: pos.inMaster,
        details: { vault: vault.quoteAccount, seed: vault.quoteSeed },
      });
      if (op && (await engine.runOp(op, res)) === "blocked") return res;
    }

    // ---- Phase 2–4: monitoring + deployment, hanya token graduated dengan pool terverifikasi
    const graduations = await this.db.tokenGraduation.findMany({ where: { state: "verified" } });
    for (const g of graduations) {
      const token = byMint.get(g.tokenMint);
      if (!token) continue;
      const outcome = await this.evaluateAndDeploy(token, g, res);
      if (outcome === "blocked") return res;
    }
    return res;
  }

  /**
   * Rekonsiliasi kustodi (Spec §13): saldo on-chain akun kustodi quote tiap token vs ledger
   * (dipindah − dideploy). Selisih → ALERT; hasilnya disimpan di heartbeat worker.
   */
  async reconcileVaults(): Promise<
    Array<{ tokenMint: string; account: string; ledger: string; onchain: string; ok: boolean }>
  > {
    const out = [];
    for (const pos of await reserveCustody(this.db)) {
      if (pos.funded === 0n) continue;
      const account = (await this.deps.chain.reserveVault(pos.tokenMint, pos.assetMint))
        .quoteAccount;
      const onchain = await this.deps.chain.tokenBalance(account);
      // Deploy aktif (belum confirmed) mungkin sudah mendarat: on-chain boleh lebih kecil sebesar itu.
      const ledger = pos.funded - pos.deployed;
      const ok = onchain <= ledger && onchain >= ledger - pos.pendingDeploy;
      if (!ok) {
        this.deps.logger.warn(
          { tokenMint: pos.tokenMint, account, ledger, onchain },
          "ALERT: saldo kustodi reserve ≠ ledger",
        );
      }
      out.push({
        tokenMint: pos.tokenMint,
        account,
        ledger: ledger.toString(),
        onchain: onchain.toString(),
        ok,
      });
    }
    return out;
  }

  private async ensureVault(tokenMint: string, quoteMint: string) {
    const v = await this.deps.chain.reserveVault(tokenMint, quoteMint);
    await this.db.reserveVault.upsert({
      where: { tokenMint },
      create: { tokenMint, quoteMint, ...v },
      update: {},
    });
  }

  /** Spec §11 Phase 2 + §12. Mengembalikan "blocked" bila signer menahan (pause/batas). */
  private async evaluateAndDeploy(
    token: {
      mint: string | null;
      quoteMint: string;
      quoteConfigId: string;
      graduatedAt: Date | null;
    },
    g: {
      tokenMint: string;
      state: string;
      cpmmPool: string | null;
      lpMint: string | null;
      addLiquiditySupported: boolean;
      reserveMonitoringActive: boolean;
    },
    res: CycleResult,
  ): Promise<"done" | "blocked"> {
    const mint = token.mint!;
    const now = this.now();
    const nowS = Math.floor(now.getTime() / 1000);
    const pair = await this.pairOf(token);
    if (!pair) {
      // Desimal tidak diketahui: tidak ada keputusan yang bisa dihitung dengan benar.
      res.skipped.push({ target: mint, reason: "pair tidak dikenal" });
      return "done";
    }
    const [pos] = await reserveCustody(this.db, { tokenMint: mint });
    const position: ReserveCustody | undefined =
      pos?.assetMint === token.quoteMint ? pos : undefined;
    const inVault = position?.inVault ?? 0n;
    const quoteDecimals = pair.decimals;
    const price = await this.quotePrice(token, pair);
    const quoteUsd = price.usd;
    if (quoteUsd === null) {
      this.deps.logger.warn(
        { tokenMint: mint, issues: price.issues, deviationBps: price.deviationBps },
        "ALERT: harga quote/USD tidak terverifikasi, deployment reserve ditahan",
      );
    }
    const override = await this.db.reserveConfigOverride.findUnique({ where: { tokenMint: mint } });
    const cfg: ReserveConfig = {
      ...this.cfg,
      ...((override?.params ?? {}) as Partial<ReserveConfig>),
      status: this.cfg.status,
    };

    const metrics: ReservePoolMetrics | null =
      g.reserveMonitoringActive && pair ? await this.deps.chain.reservePool({ mint, pair }) : null;
    const lastDeploy = await this.db.economicOp.findFirst({
      where: { kind: "reserve_deploy", tokenMint: mint, status: "confirmed" },
      orderBy: { confirmedAt: "desc" },
    });

    // Deploy maksimum: 25% saldo kustodi (Spec §12), dibatasi nominal per run & porsi pool (extra).
    let deployQuote = (inVault * BigInt(cfg.maxDeployPctPerRunBps)) / BigInt(BPS_DENOMINATOR);
    if (quoteUsd !== null && quoteUsd > 0) {
      const absCap = BigInt(
        Math.floor((cfg.maxDeployAbsPerRunUsd / quoteUsd) * 10 ** quoteDecimals),
      );
      if (deployQuote > absCap) deployQuote = absCap;
    }
    if (metrics) {
      const shareCap =
        (metrics.reserveQuote * BigInt(cfg.maxReserveShareOfPoolBps)) / BigInt(BPS_DENOMINATOR);
      if (deployQuote > shareCap) deployQuote = shareCap;
    }

    const prep =
      metrics && pair && deployQuote > 0n
        ? await this.deps.chain.prepareReserveDeploy({
            mint,
            pair,
            deployQuote,
            slippageBps: cfg.maxSlippageBps,
          })
        : null;
    const oneHourMoveBps = metrics ? await this.oneHourMove(mint, metrics, now) : 0;
    const volume = await this.volumeChange(mint, now);
    const snapshot: ReserveMonitoringSnapshot = {
      graduationState: g.state,
      pool: g.cpmmPool,
      poolStatus: metrics?.status ?? null,
      poolQuoteRaw: metrics?.reserveQuote.toString() ?? null,
      poolTokenRaw: metrics?.reserveToken.toString() ?? null,
      poolLiquidityUsd:
        quoteUsd === null
          ? null
          : metrics
            ? units(metrics.reserveQuote, quoteDecimals) * quoteUsd
            : 0,
      depth2PctQuoteRaw: metrics?.depth2PctQuote.toString() ?? null,
      spotPrice: metrics?.spotPrice ?? null,
      priceSource: "pool_onchain",
      quoteUsd,
      quoteUsdSource: price.source,
      quoteUsdObservedAt: price.observedAt,
      quoteUsdDeviationBps: price.deviationBps,
      quoteUsdIssues: price.issues,
      oneHourMoveBps,
      volume24hRaw: volume.last.toString(),
      volumePrev24hRaw: volume.prev.toString(),
      volumeChangeBps:
        volume.prev > 0n
          ? Number(((volume.last - volume.prev) * BigInt(BPS_DENOMINATOR)) / volume.prev)
          : null,
      reserveBalanceRaw: (position?.balance ?? 0n).toString(),
      reserveInVaultRaw: inVault.toString(),
      reserveBalanceUsd: quoteUsd === null ? null : units(inVault, quoteDecimals) * quoteUsd,
      deployQuoteRaw: deployQuote.toString(),
      simulatedPriceImpactBps: prep?.ok ? prep.plan.priceImpactBps : 0,
      lastDeployAt: lastDeploy?.confirmedAt?.toISOString() ?? null,
    };

    const decision = evaluateReserveDeployment(
      {
        nowSeconds: nowS,
        poolActive: !!metrics && metrics.swapEnabled && metrics.depositEnabled,
        graduated: token.graduatedAt !== null && g.state === "verified",
        poolCompatible: g.addLiquiditySupported && g.reserveMonitoringActive && !!g.lpMint,
        swapRouteAvailable: !!prep?.ok,
        reserveBalanceUsd: snapshot.reserveBalanceUsd,
        poolLiquidityUsd: snapshot.poolLiquidityUsd,
        // Harga token dari cadangan pool yang baru dibaca; konversi USD = harga asumsi pair (devnet)
        // atau umur harga SOL/USD terverifikasi (mainnet). Tanpa harga → check ini gagal.
        priceAgeSeconds: metrics ? price.ageSeconds : null,
        oneHourMoveBps,
        simulatedPriceImpactBps: snapshot.simulatedPriceImpactBps,
        lastDeployAtSeconds: lastDeploy?.confirmedAt
          ? Math.floor(lastDeploy.confirmedAt.getTime() / 1000)
          : null,
        graduatedAtSeconds: token.graduatedAt
          ? Math.floor(token.graduatedAt.getTime() / 1000)
          : null,
        paused: override?.paused ?? false,
      },
      cfg,
    );
    const reasons = [...decision.reasons];
    if (quoteUsd === null) {
      reasons.push(
        "The SOL/USD price is not verified right now, so nothing is deployed until it is.",
      );
    }
    if (prep && !prep.ok) reasons.push(`Deployment could not be prepared: ${prep.reason}`);
    if (inVault <= 0n) reasons.push("No reserve is held in this token's custody account yet.");
    const extra = await this.platformLimits(mint, now, cfg);
    reasons.push(...extra);
    const allowed =
      quoteUsd !== null &&
      decision.allowed &&
      reasons.length === decision.reasons.length &&
      !!prep?.ok;

    const record = await this.db.reserveDecision.create({
      data: {
        tokenMint: mint,
        allowed,
        amount: new Prisma.Decimal(allowed ? deployQuote.toString() : "0"),
        reasons,
        inputSnapshot: {
          ...snapshot,
          failedSafetyChecks: decision.failedSafetyChecks,
          configStatus: cfg.status,
        } as Prisma.InputJsonValue,
      },
    });
    if (!allowed || !prep?.ok) {
      res.skipped.push({ target: mint, reason: reasons[0] ?? "ditahan" });
      return "done";
    }

    const plan = prep.plan;
    const op = await this.createDeployOp(mint, now, cfg, {
      tokenMint: mint,
      assetMint: token.quoteMint,
      amountIn: plan.deployQuote,
      minOut: plan.swapMinOut,
      details: {
        decisionId: record.id,
        pool: plan.pool,
        lpMint: plan.lpMint,
        reserveBeforeRaw: (position?.balance ?? 0n).toString(),
        inVaultBeforeRaw: inVault.toString(),
        swapIn: plan.swapIn.toString(),
        swapExpectedOut: plan.swapExpectedOut.toString(),
        swapMinOut: plan.swapMinOut.toString(),
        lpAmount: plan.lpAmount.toString(),
        maxQuote: plan.maxQuote.toString(),
        maxToken: plan.maxToken.toString(),
        priceImpactBps: plan.priceImpactBps,
        slippageBps: cfg.maxSlippageBps,
        lockMethod: "burn",
      },
    });
    if (!op) return "done"; // proses lain sudah membuat deployment untuk token ini
    return (await this.deps.engine.runOp(op, res)) === "blocked" ? "blocked" : "done";
  }

  /**
   * Membuat operasi reserve_deploy secara atomik per token: advisory lock + cek ulang cooldown di
   * dalam transaksi DB yang sama. Dua worker yang mengevaluasi bersamaan tidak bisa sama-sama
   * membuat deployment (yang kedua melihat operasi aktif/terkonfirmasi milik yang pertama).
   */
  private async createDeployOp(
    mint: string,
    now: Date,
    cfg: ReserveConfig,
    data: {
      tokenMint: string;
      assetMint: string;
      amountIn: bigint;
      minOut: bigint;
      details: Record<string, unknown>;
    },
  ) {
    return this.db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`reserve_deploy:${mint}`}, 0))`;
      const since = new Date(now.getTime() - cfg.cooldownSeconds * 1000);
      const recent = await tx.economicOp.count({
        where: {
          kind: "reserve_deploy",
          tokenMint: mint,
          OR: [
            { status: { in: ["pending", "signed", "submitted"] } },
            { status: "confirmed", confirmedAt: { gte: since } },
          ],
        },
      });
      if (recent > 0) return null;
      const seq = await tx.economicOp.count({ where: { kind: "reserve_deploy", target: mint } });
      return tx.economicOp.create({
        data: {
          kind: "reserve_deploy",
          target: mint,
          tokenMint: data.tokenMint,
          assetMint: data.assetMint,
          idempotencyKey: `reserve_deploy:${mint}:${seq + 1}`,
          amountIn: new Prisma.Decimal(data.amountIn.toString()),
          minOut: new Prisma.Decimal(data.minOut.toString()),
          details: data.details as Prisma.InputJsonValue,
        },
      });
    });
  }

  /** Batas tambahan (extra di luar Spec)
: jumlah per jendela, global harian, backoff gagal. */
  private async platformLimits(mint: string, now: Date, cfg: ReserveConfig): Promise<string[]> {
    const out: string[] = [];
    const windowStart = new Date(now.getTime() - cfg.deployWindowSeconds * 1000);
    const inWindow = await this.db.economicOp.count({
      where: {
        kind: "reserve_deploy",
        tokenMint: mint,
        status: "confirmed",
        confirmedAt: { gte: windowStart },
      },
    });
    if (inWindow >= cfg.maxDeploysPerWindow) out.push("Deployment limit for this window reached.");
    const global = await this.db.economicOp.count({
      where: {
        kind: "reserve_deploy",
        status: "confirmed",
        confirmedAt: { gte: new Date(now.getTime() - DAY_MS) },
      },
    });
    if (global >= cfg.globalMaxDeploysPerDay)
      out.push("Platform-wide daily deployment limit reached.");
    const lastFail = await this.db.economicOp.findFirst({
      where: { kind: "reserve_deploy", tokenMint: mint, status: { in: ["failed", "expired"] } },
      orderBy: { updatedAt: "desc" },
    });
    if (
      lastFail &&
      now.getTime() - lastFail.updatedAt.getTime() < cfg.failureBackoffSeconds * 1000
    ) {
      out.push("Waiting after a failed deployment attempt (failure backoff).");
    }
    return out;
  }

  /** Perubahan harga terhadap trade ±1 jam lalu, atau likuiditas terhadap snapshot ±1 jam lalu. */
  private async oneHourMove(mint: string, m: ReservePoolMetrics, now: Date): Promise<number> {
    const hourAgo = new Date(now.getTime() - HOUR_MS);
    const ref = await this.db.tradeReceipt.findFirst({
      where: { tokenMint: mint, priceQuote: { not: null }, createdAt: { lte: hourAgo } },
      orderBy: { createdAt: "desc" },
    });
    const bps = (a: number, b: number) => (b > 0 ? Math.round((Math.abs(a - b) / b) * 10_000) : 0);
    let move = ref?.priceQuote ? bps(m.spotPrice, Number(ref.priceQuote)) : 0;
    const prev = await this.db.reserveDecision.findFirst({
      where: { tokenMint: mint, createdAt: { lte: hourAgo } },
      orderBy: { createdAt: "desc" },
    });
    const prevQuote = (prev?.inputSnapshot as { poolQuoteRaw?: string | null } | null)
      ?.poolQuoteRaw;
    if (prevQuote) move = Math.max(move, bps(Number(m.reserveQuote), Number(prevQuote)));
    return move;
  }

  private async volumeChange(mint: string, now: Date) {
    const sum = async (from: Date, to: Date) => {
      const agg = await this.db.tradeReceipt.aggregate({
        where: { tokenMint: mint, createdAt: { gte: from, lt: to } },
        _sum: { amountQuote: true },
      });
      return BigInt(agg._sum.amountQuote?.toFixed(0) ?? "0");
    };
    const t = now.getTime();
    return {
      last: await sum(new Date(t - DAY_MS), now),
      prev: await sum(new Date(t - 2 * DAY_MS), new Date(t - DAY_MS)),
    };
  }
}

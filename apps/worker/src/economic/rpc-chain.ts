import {
  WSOL_MINT,
  type GraduatedRoute,
  type PairConfig,
  type PlatformAddresses,
} from "@liftoff/shared";
import {
  buildBurnTx,
  buildBuybackTx,
  buildClaimCpmmTx,
  buildClaimCurveTx,
  readCpmmClaimable,
  readCurveClaimable,
  readLandedTx,
  tokenAccountBalance,
  type EconomicTxEnv,
} from "@liftoff/solana/economic";
import {
  buildReserveDeployTx,
  buildReserveFundTx,
  planReserveDeploy,
  poolMetrics,
  reserveVaultAddresses,
} from "@liftoff/solana/reserve";
import { associatedTokenAddress, mintProgramOf } from "@liftoff/solana/token-program";
import {
  getTransactionAnyVersion,
  loadMarket,
  quoteFromMarket,
  TradeError,
  TOKEN_PROGRAM,
  UnsupportedTransactionError,
  type Market,
  type TradeEnv,
} from "@liftoff/solana/trade";
import { PublicKey, type Connection } from "@solana/web3.js";
import type { SignatureStatus } from "../launch/ports";
import type {
  BuybackPreparation,
  EconomicChain,
  InboundCredit,
  ReserveDeployPlanFields,
  ReserveDeployPreparation,
  ReserveDeployProof,
} from "./ports";

const SPL_BURN_TAG = 8;
const NATIVE_SIGNATURE_PAGE = 100;

export class RpcEconomicChain implements EconomicChain {
  private readonly env: EconomicTxEnv;
  private readonly tradeEnv: TradeEnv;

  constructor(
    private readonly connection: Connection,
    private readonly platform: PlatformAddresses,
    opts: {
      computeUnitLimit: number;
      computeUnitPriceMicroLamports: number;
      graduatedRoute: GraduatedRoute;
    },
  ) {
    this.env = { connection, platform, ...opts };
    this.tradeEnv = {
      connection,
      platform,
      referralWallet: null,
      graduatedRoute: opts.graduatedRoute,
    };
  }

  async masterLamports() {
    return BigInt(
      await this.connection.getBalance(new PublicKey(this.platform.masterWallet), "confirmed"),
    );
  }

  tokenBalance(account: string) {
    return tokenAccountBalance(this.connection, account);
  }

  curveClaimable(quoteMint: string) {
    return readCurveClaimable(this.env, quoteMint);
  }

  cpmmClaimable(pool: string) {
    return readCpmmClaimable(this.env, pool);
  }

  async prepareBuyback(p: {
    mint: string;
    pair: PairConfig;
    amountIn: bigint;
    slippageBps: number;
  }): Promise<BuybackPreparation> {
    try {
      const target = { mint: p.mint, pair: p.pair };
      const market = await loadMarket(this.tradeEnv, target);
      if (market.route === "jupiter") {
        return { ok: false, reason: "jalur jupiter (mainnet) belum diimplementasikan — Tahap 10" };
      }
      const q = quoteFromMarket(this.tradeEnv, target, market, {
        side: "buy",
        amountIn: p.amountIn,
        slippageBps: p.slippageBps,
      });
      return {
        ok: true,
        buyback: {
          route: market.route,
          amountIn: BigInt(q.amountIn),
          expectedOut: BigInt(q.expectedOut),
          minOut: BigInt(q.minOut),
          priceImpactBps: q.priceImpactBps,
        },
      };
    } catch (err) {
      if (err instanceof TradeError) return { ok: false, reason: `${err.code}: ${err.message}` };
      throw err;
    }
  }

  buildClaimCurve(quoteMint: string) {
    return buildClaimCurveTx(this.env, quoteMint);
  }

  buildClaimCpmm(pool: string) {
    return buildClaimCpmmTx(this.env, pool);
  }

  async buildBuyback(p: { mint: string; pair: PairConfig; amountIn: bigint; minOut: bigint }) {
    const target = { mint: p.mint, pair: p.pair };
    const market = await loadMarket(this.tradeEnv, target);
    // Nominal & minOut PERSIS dari baris economic_ops (dicek signer); market dibaca segar.
    const quote = quoteFromMarket(this.tradeEnv, target, market, {
      side: "buy",
      amountIn: p.amountIn,
      slippageBps: 0,
    });
    return buildBuybackTx(this.env, target, market, {
      ...quote,
      amountIn: p.amountIn.toString(),
      minOut: p.minOut.toString(),
    });
  }

  buildBurn(p: { mint: string; amount: bigint; closeAccount: boolean }) {
    return buildBurnTx(this.env, p.mint, p.amount, p.closeAccount);
  }

  async signatureStatuses(signatures: string[]): Promise<Array<SignatureStatus | null>> {
    const res = await this.connection.getSignatureStatuses(signatures, {
      searchTransactionHistory: true,
    });
    return res.value.map((s) =>
      s ? { slot: s.slot, err: s.err, confirmationStatus: s.confirmationStatus ?? null } : null,
    );
  }

  blockHeight() {
    return this.connection.getBlockHeight("confirmed");
  }

  async inboundCredits(account: string, opts: { until: string | null; limit: number }) {
    const sigs = await this.connection.getSignaturesForAddress(
      new PublicKey(account),
      { limit: opts.limit, ...(opts.until ? { until: opts.until } : {}) },
      "confirmed",
    );
    const credits: InboundCredit[] = [];
    // Terlama dulu, agar kursor maju berurutan.
    for (const s of [...sigs].reverse()) {
      const tx = await getTransactionAnyVersion(this.connection, s.signature);
      if (!tx) continue;
      const keys = tx.transaction.message.getAccountKeys({
        accountKeysFromLookups: tx.meta?.loadedAddresses ?? null,
      });
      const key = (i: number) => keys.get(i)?.toBase58() ?? "";
      const idx = keys.staticAccountKeys.findIndex((k) => k.toBase58() === account);
      const pre = tx.meta?.preTokenBalances ?? [];
      const post = tx.meta?.postTokenBalances ?? [];
      const amountAt = (list: typeof pre, i: number) =>
        BigInt(list.find((b) => b.accountIndex === i)?.uiTokenAmount.amount ?? "0");
      const own = post.find((b) => key(b.accountIndex) === account);
      const accIndex = own?.accountIndex ?? idx;
      if (accIndex < 0) continue;
      const mint = own?.mint ?? pre.find((b) => b.accountIndex === accIndex)?.mint;
      if (!mint) continue;
      const delta = amountAt(post, accIndex) - amountAt(pre, accIndex);
      const sourceOwners = post
        .filter((b) => b.mint === mint && b.accountIndex !== accIndex)
        .filter((b) => amountAt(post, b.accountIndex) < amountAt(pre, b.accountIndex))
        .map((b) => b.owner ?? "")
        .filter(Boolean);
      const header = tx.transaction.message.header;
      const signers = keys.staticAccountKeys
        .slice(0, header.numRequiredSignatures)
        .map((k) => k.toBase58());
      const programs = new Set(
        tx.transaction.message.compiledInstructions.map((ix) => key(ix.programIdIndex)),
      );
      for (const inner of tx.meta?.innerInstructions ?? []) {
        for (const ix of inner.instructions) programs.add(key(ix.programIdIndex));
      }
      credits.push({
        signature: s.signature,
        slot: tx.slot,
        failed: tx.meta?.err != null,
        mint,
        amount: delta,
        signers,
        sourceOwners,
        programs: [...programs],
      });
    }
    return { credits, newest: sigs[0]?.signature ?? null };
  }

  async inboundNativeCredits(wallet: string, opts: { until: string | null }) {
    const address = new PublicKey(wallet);
    const sigs: Awaited<ReturnType<Connection["getSignaturesForAddress"]>> = [];
    for (let before: string | undefined; ; before = sigs.at(-1)!.signature) {
      const page = await this.connection.getSignaturesForAddress(
        address,
        {
          limit: NATIVE_SIGNATURE_PAGE,
          ...(opts.until ? { until: opts.until } : {}),
          ...(before ? { before } : {}),
        },
        "confirmed",
      );
      sigs.push(...page);
      if (page.length < NATIVE_SIGNATURE_PAGE) break;
    }
    const credits: InboundCredit[] = [];
    let cursor = opts.until;
    // Terlama dulu; transaksi yang belum tersedia di RPC menghentikan kursor agar tidak terlewat.
    for (const s of sigs.reverse()) {
      if (!s.err) {
        const tx = await getTransactionAnyVersion(this.connection, s.signature).catch(
          (err: unknown) => {
            // Transfer forwarder tidak memakai lookup table, jadi aman dilewati.
            if (err instanceof UnsupportedTransactionError) return "skip" as const;
            throw err;
          },
        );
        if (!tx || (tx !== "skip" && !tx.meta)) break;
        if (tx !== "skip") {
          const meta = tx.meta!;
          const keys = tx.transaction.message.getAccountKeys({
            accountKeysFromLookups: meta.loadedAddresses ?? null,
          });
          let index = -1;
          for (let i = 0; i < keys.length; i++) {
            if (keys.get(i)?.toBase58() === wallet) index = i;
          }
          const amount =
            index < 0 ? 0n : BigInt(meta.postBalances[index]! - meta.preBalances[index]!);
          if (amount > 0n) {
            credits.push({
              signature: s.signature,
              slot: tx.slot,
              failed: false,
              mint: WSOL_MINT,
              amount,
              signers: keys.staticAccountKeys
                .slice(0, tx.transaction.message.header.numRequiredSignatures)
                .map((k) => k.toBase58()),
              sourceOwners: [],
              programs: [],
            });
          }
        }
      }
      cursor = s.signature;
    }
    return { credits, cursor };
  }

  async landedTx(signature: string) {
    const tx = await readLandedTx(this.connection, signature, this.platform);
    if (!tx) return null;
    return { slot: tx.slot, failed: tx.failed, tokenDeltas: tx.tokenDeltas };
  }

  // ---------------------------------------------------------------- Conviction Reserve

  async accountExists(address: string) {
    return (await this.connection.getAccountInfo(new PublicKey(address), "confirmed")) !== null;
  }

  private async cpmmMarket(mint: string, pair: PairConfig) {
    const market: Market = await loadMarket(
      { ...this.tradeEnv, graduatedRoute: "cpmm" },
      { mint, pair },
    );
    if (market.route !== "cpmm") throw new TradeError("route_unavailable", "pool CPMM belum ada");
    return market;
  }

  async reservePool(p: { mint: string; pair: PairConfig }) {
    try {
      return poolMetrics(await this.cpmmMarket(p.mint, p.pair), p.mint);
    } catch (err) {
      if (err instanceof TradeError) return null;
      throw err;
    }
  }

  async prepareReserveDeploy(p: {
    mint: string;
    pair: PairConfig;
    deployQuote: bigint;
    slippageBps: number;
  }): Promise<ReserveDeployPreparation> {
    try {
      const target = { mint: p.mint, pair: p.pair };
      const market = await this.cpmmMarket(p.mint, p.pair);
      const q = quoteFromMarket(this.tradeEnv, target, market, {
        side: "buy",
        amountIn: p.deployQuote / 2n,
        slippageBps: p.slippageBps,
      });
      const plan = planReserveDeploy({
        metrics: poolMetrics(market, p.mint),
        deployQuote: p.deployQuote,
        swapExpectedOut: BigInt(q.expectedOut),
        swapMinOut: BigInt(q.minOut),
        priceImpactBps: q.priceImpactBps,
        slippageBps: p.slippageBps,
      });
      return { ok: true, plan };
    } catch (err) {
      if (err instanceof TradeError) return { ok: false, reason: `${err.code}: ${err.message}` };
      return { ok: false, reason: (err as Error).message };
    }
  }

  async buildReserveFund(p: {
    tokenMint: string;
    quoteMint: string;
    amount: bigint;
    createAccount: boolean;
  }) {
    return buildReserveFundTx(this.env, { ...p, programs: await this.programs(p) });
  }

  private async programs(p: { tokenMint: string; quoteMint: string }) {
    return {
      quote: await mintProgramOf(this.connection, p.quoteMint),
      token: await mintProgramOf(this.connection, p.tokenMint),
    };
  }

  async masterTokenAccount(mint: string) {
    return associatedTokenAddress(
      this.platform.masterWallet,
      mint,
      await mintProgramOf(this.connection, mint),
    );
  }

  async reserveVault(tokenMint: string, quoteMint: string) {
    return reserveVaultAddresses(
      this.platform.masterWallet,
      tokenMint,
      await this.programs({ tokenMint, quoteMint }),
    );
  }

  async buildReserveDeploy(p: {
    tokenMint: string;
    pair: PairConfig;
    plan: ReserveDeployPlanFields;
    createTokenAccount: boolean;
    closeLpAccount: boolean;
  }) {
    return buildReserveDeployTx(this.env, {
      tokenMint: p.tokenMint,
      quoteMint: p.pair.mint,
      market: await this.cpmmMarket(p.tokenMint, p.pair),
      plan: p.plan,
      createTokenAccount: p.createTokenAccount,
      closeLpAccount: p.closeLpAccount,
    });
  }

  async inspectReserveDeploy(
    signature: string,
    p: { lpMint: string; lpAccount: string; pool: string },
  ): Promise<ReserveDeployProof | null> {
    const tx = await this.connection.getTransaction(signature, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
    if (!tx) return null;
    const parsed = await readLandedTx(this.connection, signature, this.platform);
    const keys = tx.transaction.message.getAccountKeys({
      accountKeysFromLookups: tx.meta?.loadedAddresses ?? null,
    });
    let lpBurned = 0n;
    for (const ix of tx.transaction.message.compiledInstructions) {
      if (keys.get(ix.programIdIndex)?.toBase58() !== TOKEN_PROGRAM) continue;
      const data = Buffer.from(ix.data);
      if (data[0] !== SPL_BURN_TAG || data.length < 9) continue;
      const [account, mint] = ix.accountKeyIndexes.map((i) => keys.get(i)?.toBase58());
      if (account === p.lpAccount && mint === p.lpMint) lpBurned += data.readBigUInt64LE(1);
    }
    const swap = parsed?.cpmmEvents.find((e) => e.pool === p.pool) ?? null;
    return {
      failed: tx.meta?.err != null,
      tokenBought: swap ? swap.outputAmount : null,
      lpBurned,
      lpLeft: await tokenAccountBalance(this.connection, p.lpAccount),
    };
  }
}

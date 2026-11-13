/**
 * Trading pengguna (Tahap 5): quote, transaksi UNSIGNED, simulasi, dan pembacaan fee yang benar-
 * benar terpotong on-chain. Pengguna sendiri yang menandatangani (fee payer = wallet pengguna);
 * modul ini tidak pernah memegang key apa pun.
 *
 * Instruksi dibangun langsung dari builder level-rendah Raydium SDK (bukan `Raydium.load`), jadi
 * tidak ada instance SDK per pengguna dan hasilnya deterministik untuk diuji.
 *
 * Fee on-chain (Tahap 1, docs/poc-report.md):
 *  - LaunchLab: protocol (config `tradeFeeRate`), platform (platform `feeRate`), creator
 *    (platform `creatorFeeRate`) dan share/referral (`shareFeeRate` di instruksi, ≤
 *    `maxShareFeeRate` config) — semuanya dipotong di sisi quote, baik buy maupun sell.
 *  - CPMM: trade fee (config `tradeFeeRate`, sebagian ke protocol/fund) dipotong dari input;
 *    creator fee (config `creatorFeeRate`, bila `enableCreatorFee`) dari input atau output
 *    sesuai `feeOn` pool.
 * Rate selalu dibaca dari akun on-chain saat quote, tidak pernah di-hardcode.
 */
import {
  buyExactInInstruction,
  CpmmConfigInfoLayout,
  CpmmPoolInfoLayout,
  Curve,
  CurveCalculator,
  getCpmmPdaPoolId,
  getPdaCreatorVault,
  getPdaLaunchpadAuth,
  getLaunchpadPoolMintAProgram,
  getLaunchpadPoolMintBProgram,
  getPdaLaunchpadPoolId,
  getPdaPlatformVault,
  getPdaPoolAuthority,
  LaunchpadConfig,
  LaunchpadPool,
  makeSwapCpmmBaseInInstruction,
  PlatformConfig,
  sellExactInInstruction,
} from "@raydium-io/raydium-sdk-v2";
import {
  ComputeBudgetProgram,
  MessageV0,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
  type Connection,
  type VersionedTransactionResponse,
} from "@solana/web3.js";
import BN from "bn.js";
import {
  base58Decode,
  BPS_DENOMINATOR,
  FEE_CONFIG,
  referralShareRate,
  TRADE_CONFIG,
  type BuiltTrade,
  type GraduatedRoute,
  type PairConfig,
  type PlatformAddresses,
  type TradeConfig,
  type TradeErrorCode,
  type TradeFeeItem,
  type TradeQuote,
  type TradeRoute,
  type TradeSimulation,
} from "@liftoff/shared";
import {
  associatedTokenAddress,
  closeAccountIx,
  createAtaIdempotentIx,
  NATIVE_MINT,
  parseMintAccount,
  rememberMintProgram,
  TOKEN_PROGRAM,
  tokenAccountSize,
  unsupportedQuoteReason,
} from "./token-program";
import { encodeTransaction } from "./tx-inspect";

export {
  ASSOCIATED_TOKEN_PROGRAM,
  associatedTokenAddress,
  closeAccountIx,
  createAtaIdempotentIx,
  NATIVE_MINT,
  TOKEN_2022_PROGRAM,
  TOKEN_PROGRAM,
} from "./token-program";

/** Fee jaringan dasar per tanda tangan (lamport). */
const SIGNATURE_FEE_LAMPORTS = 5_000;

/** Error trade yang pesannya aman ditampilkan apa adanya ke pengguna. */
export class TradeError extends Error {
  constructor(
    readonly code: TradeErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "TradeError";
  }
}

export interface TradeEnv {
  connection: Connection;
  platform: PlatformAddresses;
  /** Wallet LIFTOFF penerima referral (share fee). null → tanpa referral. */
  referralWallet: string | null;
  graduatedRoute: GraduatedRoute;
  config?: TradeConfig;
}

export interface TradeTarget {
  mint: string;
  pair: PairConfig;
}

// ---------------------------------------------------------------- ATA & token helpers

function syncNativeIx(account: string) {
  return new TransactionInstruction({
    programId: new PublicKey(TOKEN_PROGRAM),
    keys: [{ pubkey: new PublicKey(account), isSigner: false, isWritable: true }],
    data: Buffer.from([17]), // SyncNative
  });
}

/** Saldo akun token SPL / Token-2022 (offset 64, u64 LE, sama di kedua program). */
function tokenAmount(data: Buffer): bigint {
  return data.readBigUInt64LE(64);
}

// ---------------------------------------------------------------- market

type LaunchPoolState = ReturnType<typeof LaunchpadPool.decode>;
type LaunchConfigState = ReturnType<typeof LaunchpadConfig.decode>;
type PlatformState = ReturnType<typeof PlatformConfig.decode>;
type CpmmPoolState = ReturnType<typeof CpmmPoolInfoLayout.decode>;
type CpmmConfigState = ReturnType<typeof CpmmConfigInfoLayout.decode>;

/** Program token sisi token (base) & sisi quote, dari state pool on-chain. */
export interface MarketPrograms {
  token: string;
  quote: string;
}

export type Market = (
  | {
      route: "launchlab";
      poolId: string;
      pool: LaunchPoolState;
      config: LaunchConfigState;
      platformConfig: PlatformState;
      slot: number;
    }
  | {
      route: "cpmm";
      poolId: string;
      launchPool: LaunchPoolState;
      pool: CpmmPoolState;
      config: CpmmConfigState;
      reserveA: bigint;
      reserveB: bigint;
    }
  | { route: "jupiter"; launchPool: LaunchPoolState }
) & { programs: MarketPrograms };

/** Program token mint A (base) & B (quote) pool LaunchLab dari `mintProgramFlag`. */
export function launchPoolPrograms(pool: LaunchPoolState): MarketPrograms {
  return {
    token: getLaunchpadPoolMintAProgram(pool.mintProgramFlag).toBase58(),
    quote: getLaunchpadPoolMintBProgram(pool.mintProgramFlag).toBase58(),
  };
}

function cpmmProgramOf(env: TradeEnv) {
  return new PublicKey(env.platform.cpmmProgram);
}

/** Pool CPMM hasil migrasi: PDA [pool, cpConfigId platform, token0, token1] (mint terurut). */
export function migratedCpmmPoolAddress(
  cpmmProgram: string,
  cpConfigId: string,
  mintA: string,
  mintB: string,
) {
  const a = new PublicKey(mintA);
  const b = new PublicKey(mintB);
  const [t0, t1] = Buffer.compare(a.toBuffer(), b.toBuffer()) < 0 ? [a, b] : [b, a];
  return getCpmmPdaPoolId(
    new PublicKey(cpmmProgram),
    new PublicKey(cpConfigId),
    t0,
    t1,
  ).publicKey.toBase58();
}

/**
 * Membaca state on-chain dan memilih rute: LaunchLab (status 0), menunggu migrasi (status 1 →
 * ditolak dengan pesan jelas), atau sesudah graduate (status 2 → CPMM / Jupiter sesuai config).
 * Hanya token yang diluncurkan lewat Platform PDA LIFTOFF yang diterima.
 */
export async function loadMarket(env: TradeEnv, t: TradeTarget): Promise<Market> {
  const program = new PublicKey(env.platform.launchlabProgram);
  const poolId = getPdaLaunchpadPoolId(
    program,
    new PublicKey(t.mint),
    new PublicKey(t.pair.mint),
  ).publicKey;
  const poolInfo = await env.connection.getAccountInfo(poolId, "confirmed");
  if (!poolInfo || !poolInfo.owner.equals(program)) {
    throw new TradeError("pool_not_found", "No LIFTOFF bonding curve exists for this token.");
  }
  const pool = LaunchpadPool.decode(poolInfo.data);
  if (pool.platformId.toBase58() !== env.platform.platformId) {
    throw new TradeError("token_not_tradable", "This token was not launched on LIFTOFF.");
  }
  if (pool.status === 1) {
    throw new TradeError(
      "curve_migrating",
      "The bonding curve is complete and is migrating to a Raydium pool. Trading resumes in a few minutes.",
    );
  }
  const programs = launchPoolPrograms(pool);
  rememberMintProgram(t.mint, programs.token);
  rememberMintProgram(t.pair.mint, programs.quote);
  const quoteIs2022 = programs.quote !== TOKEN_PROGRAM;
  const [cfgInfo, platInfo, quoteMintInfo] = await env.connection.getMultipleAccountsInfo(
    [pool.configId, pool.platformId, ...(quoteIs2022 ? [new PublicKey(t.pair.mint)] : [])],
    "confirmed",
  );
  if (!cfgInfo || !platInfo)
    throw new TradeError("pool_not_found", "Curve config not found on-chain.");
  if (quoteIs2022) {
    // Quote Token-2022 (mis. xStocks): transfer fee / hook mengubah jumlah → tolak aman.
    const info = quoteMintInfo
      ? parseMintAccount(quoteMintInfo.owner.toBase58(), quoteMintInfo.data)
      : null;
    const reason = info ? unsupportedQuoteReason(info) : "Quote mint not found on-chain.";
    if (reason) throw new TradeError("route_unavailable", reason);
  }
  const config = LaunchpadConfig.decode(cfgInfo.data);
  const platformConfig = PlatformConfig.decode(platInfo.data);

  if (pool.status === 0) {
    const slot = await env.connection.getSlot("confirmed");
    return {
      route: "launchlab",
      poolId: poolId.toBase58(),
      pool,
      config,
      platformConfig,
      slot,
      programs,
    };
  }
  if (pool.status !== 2) {
    throw new TradeError("route_unavailable", `Unknown curve status ${pool.status}.`);
  }
  if (env.graduatedRoute === "jupiter") return { route: "jupiter", launchPool: pool, programs };

  const cpmmProgram = cpmmProgramOf(env);
  const cpmmPoolId = migratedCpmmPoolAddress(
    cpmmProgram.toBase58(),
    platformConfig.cpConfigId.toBase58(),
    t.mint,
    t.pair.mint,
  );
  const cpInfo = await env.connection.getAccountInfo(new PublicKey(cpmmPoolId), "confirmed");
  if (!cpInfo || !cpInfo.owner.equals(cpmmProgram)) {
    throw new TradeError(
      "curve_migrated",
      "The token graduated but its Raydium pool was not found yet. Try again shortly.",
    );
  }
  const cp = CpmmPoolInfoLayout.decode(cpInfo.data);
  const tokenIsA = cp.mintA.toBase58() === t.mint;
  const [cpCfg, vaultA, vaultB] = await env.connection.getMultipleAccountsInfo(
    [cp.configId, cp.vaultA, cp.vaultB],
    "confirmed",
  );
  if (!cpCfg || !vaultA || !vaultB)
    throw new TradeError("pool_not_found", "Raydium pool accounts not found.");
  const cpConfig = CpmmConfigInfoLayout.decode(cpCfg.data);
  const big = (bn: BN) => BigInt(bn.toString());
  return {
    route: "cpmm",
    poolId: cpmmPoolId,
    launchPool: pool,
    pool: cp,
    config: cpConfig,
    reserveA:
      tokenAmount(vaultA.data) -
      big(cp.protocolFeesMintA) -
      big(cp.fundFeesMintA) -
      big(cp.creatorFeesMintA),
    reserveB:
      tokenAmount(vaultB.data) -
      big(cp.protocolFeesMintB) -
      big(cp.fundFeesMintB) -
      big(cp.creatorFeesMintB),
    programs: {
      token: (tokenIsA ? cp.mintProgramA : cp.mintProgramB).toBase58(),
      quote: (tokenIsA ? cp.mintProgramB : cp.mintProgramA).toBase58(),
    },
  };
}

/** Pool yang sah untuk token LIFTOFF: curve LaunchLab dan pool CPMM hasil migrasinya. */
export async function poolAddressesFor(env: TradeEnv, t: TradeTarget) {
  const program = new PublicKey(env.platform.launchlabProgram);
  const launchPool = getPdaLaunchpadPoolId(
    program,
    new PublicKey(t.mint),
    new PublicKey(t.pair.mint),
  ).publicKey.toBase58();
  const plat = await env.connection.getAccountInfo(
    new PublicKey(env.platform.platformId),
    "confirmed",
  );
  if (!plat) throw new Error("platform config LIFTOFF tidak ditemukan on-chain");
  const cpConfig = PlatformConfig.decode(plat.data).cpConfigId.toBase58();
  return {
    launchPool,
    cpmmPool: migratedCpmmPoolAddress(cpmmProgramOf(env).toBase58(), cpConfig, t.mint, t.pair.mint),
  };
}

// ---------------------------------------------------------------- quote

export interface QuoteParams {
  side: "buy" | "sell";
  amountIn: bigint;
  slippageBps: number;
}

function applySlippage(amount: bigint, slippageBps: number): bigint {
  return (amount * BigInt(BPS_DENOMINATOR - slippageBps)) / BigInt(BPS_DENOMINATOR);
}

function priceImpactBps(idealOut: number, actualOut: number): number {
  if (!(idealOut > 0) || !Number.isFinite(idealOut)) return 0;
  return Math.max(0, Math.round((1 - actualOut / idealOut) * BPS_DENOMINATOR));
}

function feeMismatch(
  rates: Array<{ kind: "platform" | "creator"; configuredBps: number; onChainRate: number }>,
): TradeQuote["feeConfigMismatch"] {
  const off = rates.filter((r) => r.onChainRate * BPS_DENOMINATOR !== r.configuredBps * 1_000_000);
  return off.length ? off : null;
}

/** Rate referral yang dipasang di trade LaunchLab ini (0 jika tidak ada wallet referral). */
export function shareRateFor(env: TradeEnv, config: LaunchConfigState): number {
  if (!env.referralWallet) return 0;
  return referralShareRate(Number(config.maxShareFeeRate.toString()));
}

function quoteLaunchlab(
  env: TradeEnv,
  t: TradeTarget,
  m: Extract<Market, { route: "launchlab" }>,
  p: QuoteParams,
): TradeQuote {
  const shareRate = shareRateFor(env, m.config);
  const rates = {
    protocolFeeRate: m.config.tradeFeeRate,
    platformFeeRate: m.platformConfig.feeRate,
    shareFeeRate: new BN(shareRate),
    creatorFeeRate: m.platformConfig.creatorFeeRate,
  };
  const common = {
    poolInfo: m.pool,
    curveType: m.config.curveType,
    transferFeeConfigA: undefined,
    transferFeeConfigB: undefined,
    slot: m.slot,
    ...rates,
  };
  const amount = new BN(p.amountIn.toString());
  const decA = m.pool.mintDecimalsA;
  const decB = m.pool.mintDecimalsB;
  const spot = Number(
    Curve.getPrice({
      poolInfo: m.pool,
      curveType: m.config.curveType,
      decimalA: decA,
      decimalB: decB,
    }).toString(),
  );

  let amountInUsed: bigint;
  let expectedOut: bigint;
  let completesCurve = false;
  const warnings: string[] = [];
  let split: ReturnType<typeof Curve.splitFee>;
  let impact: number;
  if (p.side === "buy") {
    const remaining = BigInt(m.pool.totalSellA.sub(m.pool.realA).toString());
    if (remaining <= 0n)
      throw new TradeError("curve_migrating", "The bonding curve is already complete.");
    const r = Curve.buyExactIn({ ...common, amountB: amount });
    amountInUsed = BigInt(r.amountB.toString());
    expectedOut =
      BigInt(r.amountA.amount.toString()) - BigInt((r.amountA.fee ?? new BN(0)).toString());
    split = r.splitFee;
    completesCurve = expectedOut >= remaining;
    if (amountInUsed < p.amountIn) {
      warnings.push("This buy completes the bonding curve; only the amount needed is spent.");
    }
    const net = Number(amountInUsed - BigInt(totalOf(split).toString())) / 10 ** decB;
    impact = priceImpactBps(net / spot, Number(expectedOut) / 10 ** decA);
  } else {
    const r = Curve.sellExactIn({ ...common, amountA: amount });
    amountInUsed = p.amountIn;
    expectedOut = BigInt(r.amountB.toString());
    split = r.splitFee;
    const gross = Number(expectedOut + BigInt(totalOf(split).toString())) / 10 ** decB;
    impact = priceImpactBps((Number(p.amountIn) / 10 ** decA) * spot, gross);
  }
  if (expectedOut <= 0n) throw new TradeError("amount_too_small", "Amount is too small to trade.");

  const quoteMint = t.pair.mint;
  const fees: TradeFeeItem[] = [
    {
      kind: "platform",
      // Spec: platform fee milik StonkFun (devnet: StonkFun tiruan), bukan pendapatan LIFTOFF.
      label: "StonkFun platform fee",
      rate: Number(rates.platformFeeRate.toString()),
      amount: split.platformFee.toString(),
      mint: quoteMint,
      recipient: getPdaPlatformVault(
        new PublicKey(env.platform.launchlabProgram),
        m.pool.platformId,
        m.pool.mintB,
      ).publicKey.toBase58(),
    },
    {
      kind: "raydium_protocol",
      label: "Raydium protocol fee",
      rate: Number(rates.protocolFeeRate.toString()),
      amount: split.protocolFee.toString(),
      mint: quoteMint,
      recipient: m.config.protocolFeeOwner.toBase58(),
    },
  ];
  if (shareRate > 0) {
    fees.push({
      kind: "referral",
      label: "LIFTOFF referral fee",
      rate: shareRate,
      amount: split.shareFee.toString(),
      mint: quoteMint,
      recipient: env.referralWallet,
    });
  }
  if (!rates.creatorFeeRate.isZero()) {
    fees.push({
      kind: "creator",
      label: "Creator fee (80% buyback & burn / 20% reserve)",
      rate: Number(rates.creatorFeeRate.toString()),
      amount: split.creatorFee.toString(),
      mint: quoteMint,
      recipient: m.pool.creator.toBase58(),
    });
  }
  const raised = BigInt(m.pool.realB.toString());
  const target = BigInt(m.pool.totalFundRaisingB.toString());
  return {
    route: "launchlab",
    side: p.side,
    mint: t.mint,
    quoteMint,
    quoteSymbol: t.pair.symbol,
    quoteDecimals: decB,
    tokenDecimals: decA,
    pool: m.poolId,
    amountIn: amountInUsed.toString(),
    amountInRequested: p.amountIn.toString(),
    expectedOut: expectedOut.toString(),
    minOut: applySlippage(expectedOut, p.slippageBps).toString(),
    slippageBps: p.slippageBps,
    fees,
    priceImpactBps: impact,
    spotPrice: String(spot),
    curve: {
      status: m.pool.status,
      progressPct: target > 0n ? Number((raised * 10_000n) / target) / 100 : 0,
      raisedQuote: raised.toString(),
      targetQuote: target.toString(),
      completesCurve,
    },
    feeConfigMismatch: feeMismatch([
      {
        kind: "platform",
        configuredBps: FEE_CONFIG.platformFeeBps,
        onChainRate: Number(rates.platformFeeRate.toString()),
      },
      {
        kind: "creator",
        configuredBps: FEE_CONFIG.creatorFeeBps,
        onChainRate: Number(rates.creatorFeeRate.toString()),
      },
    ]),
    warnings,
  };
}

function totalOf(split: { platformFee: BN; shareFee: BN; protocolFee: BN; creatorFee: BN }): BN {
  return split.platformFee.add(split.shareFee).add(split.protocolFee).add(split.creatorFee);
}

/** `feeOn` CPMM: 0 kedua token, 1 hanya token0, 2 hanya token1 (sama dengan program cp-swap). */
export function cpmmCreatorFeeOnInput(feeOn: number, inputIsToken0: boolean): boolean {
  if (feeOn === 0) return true;
  if (feeOn === 1) return inputIsToken0;
  return !inputIsToken0;
}

function quoteCpmm(
  env: TradeEnv,
  t: TradeTarget,
  m: Extract<Market, { route: "cpmm" }>,
  p: QuoteParams,
): TradeQuote {
  const inputMint = p.side === "buy" ? t.pair.mint : t.mint;
  const inputIsA = m.pool.mintA.toBase58() === inputMint;
  const [inRes, outRes] = inputIsA ? [m.reserveA, m.reserveB] : [m.reserveB, m.reserveA];
  const creatorOn = m.pool.enableCreatorFee;
  const creatorRate = creatorOn ? m.config.creatorFeeRate : new BN(0);
  const onInput = cpmmCreatorFeeOnInput(m.pool.feeOn, inputIsA);
  const r = CurveCalculator.swapBaseInput(
    new BN(p.amountIn.toString()),
    new BN(inRes.toString()),
    new BN(outRes.toString()),
    m.config.tradeFeeRate,
    creatorRate,
    m.config.protocolFeeRate,
    m.config.fundFeeRate,
    onInput,
  );
  const expectedOut = BigInt(r.outputAmount.toString());
  if (expectedOut <= 0n) throw new TradeError("amount_too_small", "Amount is too small to trade.");
  const outputMint = p.side === "buy" ? t.mint : t.pair.mint;
  const decIn = inputIsA ? m.pool.mintDecimalA : m.pool.mintDecimalB;
  const decOut = inputIsA ? m.pool.mintDecimalB : m.pool.mintDecimalA;
  const tokenIsA = m.pool.mintA.toBase58() === t.mint;
  const [resToken, resQuote] = tokenIsA ? [m.reserveA, m.reserveB] : [m.reserveB, m.reserveA];
  const decToken = tokenIsA ? m.pool.mintDecimalA : m.pool.mintDecimalB;
  const decQuote = tokenIsA ? m.pool.mintDecimalB : m.pool.mintDecimalA;
  const spot = Number(resQuote) / 10 ** decQuote / (Number(resToken) / 10 ** decToken);
  // Harga spot dalam unit output per unit input, untuk dampak harga.
  const spotOutPerIn = p.side === "buy" ? 1 / spot : spot;
  const tradeFee = BigInt(r.tradeFee.toString());
  // Dampak harga murni kurva: input dikurangi fee input, output ditambah creator fee sisi output.
  const creatorFee = BigInt(r.creatorFee.toString());
  const netIn = Number(p.amountIn - tradeFee - (onInput ? creatorFee : 0n)) / 10 ** decIn;
  const grossOut = Number(expectedOut + (onInput ? 0n : creatorFee)) / 10 ** decOut;
  // Satu item, sama dengan `trade_fee` di SwapEvent on-chain (sebagian ke protocol/fund Raydium,
  // sisanya ke LP — termasuk LP terkunci milik LIFTOFF).
  const fees: TradeFeeItem[] = [
    {
      kind: "raydium_lp",
      label: "Raydium pool fee",
      rate: Number(m.config.tradeFeeRate.toString()),
      amount: tradeFee.toString(),
      mint: inputMint,
      recipient: null,
    },
  ];
  if (creatorOn) {
    fees.push({
      kind: "creator",
      label: "Pool creator fee (80% buyback & burn / 20% reserve)",
      rate: Number(creatorRate.toString()),
      amount: r.creatorFee.toString(),
      mint: onInput ? inputMint : outputMint,
      recipient: m.pool.poolCreator.toBase58(),
    });
  }
  return {
    route: "cpmm",
    side: p.side,
    mint: t.mint,
    quoteMint: t.pair.mint,
    quoteSymbol: t.pair.symbol,
    quoteDecimals: decQuote,
    tokenDecimals: decToken,
    pool: m.poolId,
    amountIn: p.amountIn.toString(),
    amountInRequested: p.amountIn.toString(),
    expectedOut: expectedOut.toString(),
    minOut: applySlippage(expectedOut, p.slippageBps).toString(),
    slippageBps: p.slippageBps,
    fees,
    priceImpactBps: priceImpactBps(netIn * spotOutPerIn, grossOut),
    spotPrice: String(spot),
    curve: {
      status: m.launchPool.status,
      progressPct: 100,
      raisedQuote: m.launchPool.realB.toString(),
      targetQuote: m.launchPool.totalFundRaisingB.toString(),
      completesCurve: false,
    },
    // Sesudah graduate tidak ada platform fee LaunchLab; creator fee CPMM ke `poolCreator` =
    // master wallet → 80/20 (Spec §9). Rate milik config CPMM Raydium, dibandingkan dengan nilai
    // yang diharapkan FEE_CONFIG.
    feeConfigMismatch: feeMismatch(
      creatorOn
        ? [
            {
              kind: "creator",
              configuredBps: FEE_CONFIG.expectedCpmmCreatorFeeBps,
              onChainRate: Number(creatorRate.toString()),
            },
          ]
        : [],
    ),
    warnings: [],
  };
}

/** Jalur Jupiter belum dibuat; mainnet memakai rute cpmm (lihat deploy/.env.mainnet.example). */
const JUPITER_NOT_BUILT = "Jupiter routing is not available in LIFTOFF yet.";

export function quoteFromMarket(
  env: TradeEnv,
  t: TradeTarget,
  m: Market,
  p: QuoteParams,
): TradeQuote {
  if (p.amountIn <= 0n)
    throw new TradeError("amount_too_small", "Enter an amount greater than zero.");
  if (m.route === "launchlab") return quoteLaunchlab(env, t, m, p);
  if (m.route === "cpmm") return quoteCpmm(env, t, m, p);
  throw new TradeError("route_unavailable", JUPITER_NOT_BUILT);
}

export async function quoteTrade(
  env: TradeEnv,
  t: TradeTarget,
  p: QuoteParams,
): Promise<TradeQuote> {
  return quoteFromMarket(env, t, await loadMarket(env, t), p);
}

// ---------------------------------------------------------------- build

function tradeInstructions(
  env: TradeEnv,
  t: TradeTarget,
  m: Market,
  q: TradeQuote,
  wallet: string,
) {
  const ixs: TransactionInstruction[] = [];
  const cfg = env.config ?? TRADE_CONFIG;
  ixs.push(ComputeBudgetProgram.setComputeUnitLimit({ units: cfg.computeUnitLimit }));
  if (cfg.computeUnitPriceMicroLamports > 0) {
    ixs.push(
      ComputeBudgetProgram.setComputeUnitPrice({
        microLamports: cfg.computeUnitPriceMicroLamports,
      }),
    );
  }
  const quoteIsSol = t.pair.mint === NATIVE_MINT;
  const { token: tokenProgram, quote: quoteProgram } = m.programs;
  const userToken = associatedTokenAddress(wallet, t.mint, tokenProgram);
  const userQuote = associatedTokenAddress(wallet, t.pair.mint, quoteProgram);
  const amountIn = BigInt(q.amountIn);

  // Akun output/input selalu ATA; WSOL dibungkus sementara lalu ditutup (sisa + rent kembali).
  ixs.push(createAtaIdempotentIx(wallet, userToken, wallet, t.mint, tokenProgram));
  if (quoteIsSol) {
    ixs.push(createAtaIdempotentIx(wallet, userQuote, wallet, NATIVE_MINT));
    if (q.side === "buy") {
      ixs.push(
        SystemProgram.transfer({
          fromPubkey: new PublicKey(wallet),
          toPubkey: new PublicKey(userQuote),
          lamports: amountIn,
        }),
        syncNativeIx(userQuote),
      );
    }
  } else if (q.side === "sell") {
    ixs.push(createAtaIdempotentIx(wallet, userQuote, wallet, t.pair.mint, quoteProgram));
  }

  if (m.route === "launchlab") {
    const shareRate = shareRateFor(env, m.config);
    if (shareRate > 0 && env.referralWallet) {
      const shareAta = associatedTokenAddress(env.referralWallet, t.pair.mint, quoteProgram);
      ixs.push(
        createAtaIdempotentIx(wallet, shareAta, env.referralWallet, t.pair.mint, quoteProgram),
      );
    }
  }
  ixs.push(swapInstruction(env, t, m, q, wallet, userQuote, userToken));

  if (quoteIsSol) ixs.push(closeAccountIx(userQuote, wallet, wallet));
  return ixs;
}

/**
 * Instruksi swap tunggal (LaunchLab buy/sell exact-in atau CPMM swap_base_input) dari akun token
 * `userQuote`/`userToken` milik `wallet`. Dipakai trading pengguna dan buyback master wallet
 * (Tahap 7, dari ATA quote yang sudah berisi dana claim).
 */
export function swapInstruction(
  env: TradeEnv,
  t: TradeTarget,
  m: Market,
  q: TradeQuote,
  wallet: string,
  userQuote: string,
  userToken: string,
): TransactionInstruction {
  const minOut = new BN(q.minOut);
  if (m.route === "launchlab") {
    const program = new PublicKey(env.platform.launchlabProgram);
    const shareRate = shareRateFor(env, m.config);
    const shareAta =
      shareRate > 0 && env.referralWallet
        ? new PublicKey(associatedTokenAddress(env.referralWallet, t.pair.mint, m.programs.quote))
        : undefined;
    const args = [
      program,
      new PublicKey(wallet),
      getPdaLaunchpadAuth(program).publicKey,
      m.pool.configId,
      m.pool.platformId,
      new PublicKey(m.poolId),
      new PublicKey(userToken),
      new PublicKey(userQuote),
      m.pool.vaultA,
      m.pool.vaultB,
      new PublicKey(t.mint),
      new PublicKey(t.pair.mint),
      new PublicKey(m.programs.token),
      new PublicKey(m.programs.quote),
      getPdaPlatformVault(program, m.pool.platformId, m.pool.mintB).publicKey,
      getPdaCreatorVault(program, m.pool.creator, m.pool.mintB).publicKey,
    ] as const;
    return q.side === "buy"
      ? buyExactInInstruction(...args, new BN(q.amountIn), minOut, new BN(shareRate), shareAta)
      : sellExactInInstruction(...args, new BN(q.amountIn), minOut, new BN(shareRate), shareAta);
  }
  if (m.route === "cpmm") {
    const program = cpmmProgramOf(env);
    const inputMint = q.side === "buy" ? t.pair.mint : t.mint;
    const outputMint = q.side === "buy" ? t.mint : t.pair.mint;
    const inputIsA = m.pool.mintA.toBase58() === inputMint;
    return makeSwapCpmmBaseInInstruction(
      program,
      new PublicKey(wallet),
      getPdaPoolAuthority(program).publicKey,
      m.pool.configId,
      new PublicKey(m.poolId),
      new PublicKey(q.side === "buy" ? userQuote : userToken),
      new PublicKey(q.side === "buy" ? userToken : userQuote),
      inputIsA ? m.pool.vaultA : m.pool.vaultB,
      inputIsA ? m.pool.vaultB : m.pool.vaultA,
      inputIsA ? m.pool.mintProgramA : m.pool.mintProgramB,
      inputIsA ? m.pool.mintProgramB : m.pool.mintProgramA,
      new PublicKey(inputMint),
      new PublicKey(outputMint),
      m.pool.observationId,
      new BN(q.amountIn),
      minOut,
    );
  }
  throw new TradeError("route_unavailable", JUPITER_NOT_BUILT);
}

/** Peta log/error simulasi → kode & pesan yang bisa dipahami pengguna. */
export function classifyTradeFailure(
  logs: string[],
  err: unknown,
): { code: TradeErrorCode; message: string } {
  const text = `${logs.join("\n")}\n${typeof err === "string" ? err : JSON.stringify(err ?? "")}`;
  if (/ExceededSlippage|exceeds desired slippage|slippage/i.test(text)) {
    return {
      code: "slippage_exceeded",
      message: "Price moved beyond your slippage limit. Try again or raise max slippage.",
    };
  }
  if (/PoolMigrated|NotApproved|pool.*status/i.test(text) && /Error Code/.test(text)) {
    return {
      code: "curve_migrated",
      message:
        "The bonding curve is closed for trading (it has graduated). Refresh to trade on the Raydium pool.",
    };
  }
  if (
    /insufficient lamports|InsufficientFundsForRent|insufficient funds for rent|no record of a prior credit/i.test(
      text,
    )
  ) {
    return {
      code: "insufficient_balance",
      message: "Not enough SOL for this trade plus network fees and account rent.",
    };
  }
  if (/Error: insufficient funds|custom program error: 0x1\b/i.test(text)) {
    return {
      code: "insufficient_token_balance",
      message: "Not enough token balance for this trade.",
    };
  }
  const last = [...logs].reverse().find((l) => /error|failed/i.test(l));
  return {
    code: "simulation_failed",
    message: `Simulation failed${last ? `: ${last.replace(/^Program log: /, "")}` : "."}`,
  };
}

/**
 * Cek saldo sebelum membangun: pesan yang jelas lebih baik daripada error simulasi mentah.
 * Mengembalikan estimasi rent akun baru (lamport) yang dibayar pengguna.
 */
async function precheckBalances(
  env: TradeEnv,
  t: TradeTarget,
  m: Market,
  q: TradeQuote,
  wallet: string,
) {
  const quoteIsSol = t.pair.mint === NATIVE_MINT;
  const userToken = associatedTokenAddress(wallet, t.mint, m.programs.token);
  const userQuote = associatedTokenAddress(wallet, t.pair.mint, m.programs.quote);
  const share =
    env.referralWallet && q.fees.some((f) => f.kind === "referral")
      ? associatedTokenAddress(env.referralWallet, t.pair.mint, m.programs.quote)
      : null;
  const keys = [wallet, userToken, userQuote, ...(share ? [share] : [])].map(
    (k) => new PublicKey(k),
  );
  const [walletInfo, tokenAcc, quoteAcc, shareAcc] = await env.connection.getMultipleAccountsInfo(
    keys,
    "confirmed",
  );
  const rentOf = async (program: string) =>
    BigInt(await env.connection.getMinimumBalanceForRentExemption(tokenAccountSize(program)));
  const tokenRent = await rentOf(m.programs.token);
  const quoteRent = await rentOf(m.programs.quote);
  const lamports = BigInt(walletInfo?.lamports ?? 0);
  // Rent permanen: ATA token baru + ATA referral baru. Rent ATA WSOL sementara (dikembalikan saat close).
  let rent = 0n;
  if (!tokenAcc) rent += tokenRent;
  if (share && !shareAcc) rent += quoteRent;
  const tempRent = quoteIsSol && !quoteAcc ? quoteRent : 0n;
  const network = BigInt(SIGNATURE_FEE_LAMPORTS);
  const spendSol = quoteIsSol && q.side === "buy" ? BigInt(q.amountIn) : 0n;
  const need = spendSol + rent + tempRent + network;
  if (lamports < need) {
    const fmt = (v: bigint) => (Number(v) / 1e9).toFixed(6);
    throw new TradeError(
      "insufficient_balance",
      `Not enough SOL: this trade needs ${fmt(need)} SOL (amount + network fee + account rent), wallet has ${fmt(lamports)} SOL.`,
    );
  }
  if (q.side === "sell" || !quoteIsSol) {
    const [acc, needAmt, symbol, dec] =
      q.side === "sell"
        ? [tokenAcc, BigInt(q.amountIn), "tokens", q.tokenDecimals]
        : [quoteAcc, BigInt(q.amountIn), t.pair.symbol, q.quoteDecimals];
    const have = acc ? tokenAmount(acc.data) : 0n;
    if (have < needAmt) {
      throw new TradeError(
        q.side === "sell" ? "insufficient_token_balance" : "insufficient_balance",
        `Not enough ${symbol}: need ${Number(needAmt) / 10 ** dec}, wallet has ${Number(have) / 10 ** dec}.`,
      );
    }
  }
  return { rent, network };
}

/**
 * Quote + transaksi UNSIGNED (v0, fee payer = wallet) + simulasi tanpa verifikasi tanda tangan.
 * Wallet pengguna menandatangani & mengirim; API/master wallet tidak pernah menandatangani.
 */
export async function buildTrade(
  env: TradeEnv,
  t: TradeTarget,
  p: QuoteParams & { wallet: string },
): Promise<BuiltTrade> {
  const market = await loadMarket(env, t);
  const quote = quoteFromMarket(env, t, market, p);
  const { rent, network } = await precheckBalances(env, t, market, quote, p.wallet);
  const ixs = tradeInstructions(env, t, market, quote, p.wallet);
  const latest = await env.connection.getLatestBlockhash("confirmed");
  const message = new TransactionMessage({
    payerKey: new PublicKey(p.wallet),
    recentBlockhash: latest.blockhash,
    instructions: ixs,
  }).compileToV0Message();
  const tx = new VersionedTransaction(message);

  const sim = await env.connection.simulateTransaction(tx, {
    sigVerify: false,
    replaceRecentBlockhash: true,
    commitment: "confirmed",
  });
  let simulation: TradeSimulation;
  if (sim.value.err) {
    const failure = classifyTradeFailure(sim.value.logs ?? [], sim.value.err);
    simulation = {
      ok: false,
      unitsConsumed: sim.value.unitsConsumed ?? null,
      errorCode: failure.code,
      message: failure.message,
    };
  } else {
    simulation = {
      ok: true,
      unitsConsumed: sim.value.unitsConsumed ?? null,
      errorCode: null,
      message: null,
    };
  }
  return {
    quote,
    transaction: encodeTransaction(tx),
    lastValidBlockHeight: latest.lastValidBlockHeight,
    simulation,
    networkFeeLamports: network.toString(),
    rentLamports: rent.toString(),
  };
}

// ---------------------------------------------------------------- receipt (fee aktual on-chain)

/** Anchor `emit_cpi!`: tag instruksi event + discriminator `TradeEvent` LaunchLab. */
const EVENT_IX_TAG = "e445a52e51cb9a1d";
const LAUNCHLAB_TRADE_EVENT = "bddb7fd34ee661ee";
/** Discriminator `SwapEvent` CPMM (dari log `Program data:`). */
const CPMM_SWAP_EVENT = "40c6cde8260871e2";

export interface LaunchlabTradeEvent {
  pool: string;
  amountIn: bigint;
  amountOut: bigint;
  protocolFee: bigint;
  platformFee: bigint;
  creatorFee: bigint;
  shareFee: bigint;
  /** 0 buy, 1 sell. */
  direction: number;
  poolStatus: number;
  realQuoteAfter: bigint;
  /** Untuk harga sesudah trade: (virtualQuote + realQuoteAfter) / (virtualBase − realBaseAfter). */
  virtualBase: bigint;
  virtualQuote: bigint;
  realBaseAfter: bigint;
}

/**
 * Layout TradeEvent LaunchLab (diverifikasi terhadap trade PoC Tahap 1: platform 1.000.000,
 * protocol 250.000, share 1.102.540): pool, 13 × u64 (total_base_sell, virtual_base,
 * virtual_quote, real_base_before, real_quote_before, real_base_after, real_quote_after,
 * amount_in, amount_out, protocol_fee, platform_fee, creator_fee, share_fee), lalu direction,
 * pool status, exact_in.
 */
export function decodeLaunchlabTradeEvent(data: Buffer): LaunchlabTradeEvent | null {
  if (data.length < 8 + 8 + 32 + 13 * 8 + 3) return null;
  if (data.subarray(0, 8).toString("hex") !== EVENT_IX_TAG) return null;
  if (data.subarray(8, 16).toString("hex") !== LAUNCHLAB_TRADE_EVENT) return null;
  const pool = new PublicKey(data.subarray(16, 48)).toBase58();
  const u = (i: number) => data.readBigUInt64LE(48 + i * 8);
  const tail = 48 + 13 * 8;
  return {
    pool,
    virtualBase: u(1),
    virtualQuote: u(2),
    realBaseAfter: u(5),
    realQuoteAfter: u(6),
    amountIn: u(7),
    amountOut: u(8),
    protocolFee: u(9),
    platformFee: u(10),
    creatorFee: u(11),
    shareFee: u(12),
    direction: data[tail]!,
    poolStatus: data[tail + 1]!,
  };
}

export interface CpmmSwapEvent {
  pool: string;
  inputVaultBefore: bigint;
  outputVaultBefore: bigint;
  inputAmount: bigint;
  outputAmount: bigint;
  inputMint: string;
  outputMint: string;
  tradeFee: bigint;
  creatorFee: bigint;
  creatorFeeOnInput: boolean;
}

/** Layout SwapEvent cp-swap: pool, 6 × u64, base_input, input/output mint, trade & creator fee, flag. */
export function decodeCpmmSwapEvent(data: Buffer): CpmmSwapEvent | null {
  if (data.length < 8 + 32 + 6 * 8 + 1 + 64 + 16 + 1) return null;
  if (data.subarray(0, 8).toString("hex") !== CPMM_SWAP_EVENT) return null;
  const u = (o: number) => data.readBigUInt64LE(o);
  const o = 8 + 32;
  const m = o + 6 * 8 + 1;
  return {
    pool: new PublicKey(data.subarray(8, 40)).toBase58(),
    inputVaultBefore: u(o),
    outputVaultBefore: u(o + 8),
    inputAmount: u(o + 16),
    outputAmount: u(o + 24),
    inputMint: new PublicKey(data.subarray(m, m + 32)).toBase58(),
    outputMint: new PublicKey(data.subarray(m + 32, m + 64)).toBase58(),
    tradeFee: u(m + 64),
    creatorFee: u(m + 72),
    creatorFeeOnInput: data[m + 80] === 1,
  };
}

/**
 * Data `Program data:` yang di-emit LANGSUNG oleh `programId`. Baris log diatribusikan ke program
 * yang sedang berjalan (tumpukan `invoke`/`success`), sehingga program lain yang menyentuh akun
 * pool tidak bisa memalsukan SwapEvent CPMM (penting untuk indexer: getSignaturesForAddress
 * mengembalikan SEMUA transaksi yang merujuk pool).
 */
export function programDataLogs(logs: readonly string[], programId: string): Buffer[] {
  const stack: string[] = [];
  const out: Buffer[] = [];
  for (const line of logs) {
    const invoke = /^Program (\w+) invoke \[\d+\]$/.exec(line);
    if (invoke) {
      stack.push(invoke[1]!);
      continue;
    }
    if (/^Program \w+ (success|failed)/.test(line)) {
      stack.pop();
      continue;
    }
    const data = /^Program data: (.+)$/.exec(line);
    if (data && stack[stack.length - 1] === programId) {
      out.push(Buffer.from(data[1]!, "base64"));
    }
  }
  return out;
}

export interface OnChainTrade {
  signature: string;
  slot: number;
  wallet: string;
  failed: boolean;
  launchlab: LaunchlabTradeEvent | null;
  cpmm: CpmmSwapEvent | null;
  /** Δ saldo token per (owner, mint), dari pre/postTokenBalances. */
  tokenDeltas: Array<{ account: string; owner: string | null; mint: string; delta: bigint }>;
}

/** Transaksi terurai lengkap untuk indexer: semua event trade, bukan hanya yang pertama. */
export interface ParsedTradeTransaction extends OnChainTrade {
  blockTime: number | null;
  launchlabEvents: LaunchlabTradeEvent[];
  cpmmEvents: CpmmSwapEvent[];
  /** Semua akun yang dirujuk transaksi (statis + lookup table). */
  accountKeys: string[];
}

export interface TradePrograms {
  launchlab: string;
  cpmm: string;
}

export class UnsupportedTransactionError extends Error {
  constructor(signature: string, reason: string) {
    super(`transaksi ${signature} tidak bisa diurai: ${reason}`);
    this.name = "UnsupportedTransactionError";
  }
}

/** Hasil JSON-RPC getTransaction (encoding json) untuk transaksi yang ditolak web3.js. */
export interface RawTransactionResponse {
  slot: number;
  blockTime?: number | null;
  meta:
    | (Omit<NonNullable<VersionedTransactionResponse["meta"]>, "loadedAddresses"> & {
        loadedAddresses?: { writable: string[]; readonly: string[] };
      })
    | null;
  transaction: {
    signatures: string[];
    message: {
      header: MessageV0["header"];
      accountKeys: string[];
      recentBlockhash: string;
      instructions: Array<{ programIdIndex: number; accounts: number[]; data: string }>;
    };
  };
}

/** Menyamakan transaksi versi 1 dengan bentuk web3.js. Versi 1 tidak memakai lookup table. */
export function versionedResponseFromRaw(
  raw: RawTransactionResponse,
  signature: string,
): VersionedTransactionResponse {
  const loaded = raw.meta?.loadedAddresses;
  if (loaded && loaded.writable.length + loaded.readonly.length > 0) {
    throw new UnsupportedTransactionError(signature, "memakai lookup table");
  }
  const m = raw.transaction.message;
  return {
    slot: raw.slot,
    blockTime: raw.blockTime ?? null,
    meta: raw.meta && { ...raw.meta, loadedAddresses: { writable: [], readonly: [] } },
    version: 0,
    transaction: {
      signatures: raw.transaction.signatures,
      message: new MessageV0({
        header: m.header,
        staticAccountKeys: m.accountKeys.map((k) => new PublicKey(k)),
        recentBlockhash: m.recentBlockhash,
        compiledInstructions: m.instructions.map((ix) => ({
          programIdIndex: ix.programIdIndex,
          accountKeyIndexes: ix.accounts,
          data: base58Decode(ix.data),
        })),
        addressTableLookups: [],
      }),
    },
  };
}

const VERSION_NOT_SUPPORTED = /version.*not supported|-32015/i;

/**
 * getTransaction yang juga membaca transaksi versi 1. web3.js 1.98 menolak versi 1, jadi transaksi
 * itu diambil lewat JSON-RPC langsung. Versi yang lebih baru melempar UnsupportedTransactionError.
 */
export async function getTransactionAnyVersion(
  connection: Connection,
  signature: string,
): Promise<VersionedTransactionResponse | null> {
  try {
    return await connection.getTransaction(signature, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
  } catch (err) {
    if (!VERSION_NOT_SUPPORTED.test((err as Error).message ?? "")) throw err;
  }
  // URL RPC memuat API key: jangan ikut ke pesan error.
  const res = await fetch(connection.rpcEndpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "getTransaction",
      params: [
        signature,
        { encoding: "json", commitment: "confirmed", maxSupportedTransactionVersion: 1 },
      ],
    }),
  });
  if (!res.ok) throw new Error(`getTransaction versi 1 gagal: HTTP ${res.status}`);
  const body = (await res.json()) as {
    result?: RawTransactionResponse | null;
    error?: { code?: number; message?: string };
  };
  if (body.error) {
    const msg = `${body.error.code ?? ""} ${body.error.message ?? ""}`;
    if (VERSION_NOT_SUPPORTED.test(msg)) throw new UnsupportedTransactionError(signature, msg);
    throw new Error(`getTransaction versi 1 gagal: ${msg}`);
  }
  return body.result ? versionedResponseFromRaw(body.result, signature) : null;
}

/** Mengurai transaksi (hasil getTransaction) menjadi event trade + Δ saldo token. */
export function parseTradeTransaction(
  tx: VersionedTransactionResponse,
  signature: string,
  programs: TradePrograms,
): ParsedTradeTransaction {
  const keys = tx.transaction.message.getAccountKeys({
    accountKeysFromLookups: tx.meta?.loadedAddresses ?? null,
  });
  const launchlabEvents: LaunchlabTradeEvent[] = [];
  for (const inner of tx.meta?.innerInstructions ?? []) {
    for (const ix of inner.instructions) {
      if (keys.get(ix.programIdIndex)?.toBase58() !== programs.launchlab) continue;
      const e = decodeLaunchlabTradeEvent(Buffer.from(base58Decode(ix.data)));
      if (e) launchlabEvents.push(e);
    }
  }
  const cpmmEvents = programDataLogs(tx.meta?.logMessages ?? [], programs.cpmm)
    .map((d) => decodeCpmmSwapEvent(d))
    .filter((e): e is CpmmSwapEvent => e !== null);

  const pre = new Map<number, { owner: string | null; mint: string; amount: bigint }>();
  for (const b of tx.meta?.preTokenBalances ?? []) {
    pre.set(b.accountIndex, {
      owner: b.owner ?? null,
      mint: b.mint,
      amount: BigInt(b.uiTokenAmount.amount),
    });
  }
  const tokenDeltas: OnChainTrade["tokenDeltas"] = [];
  const seen = new Set<number>();
  for (const b of tx.meta?.postTokenBalances ?? []) {
    seen.add(b.accountIndex);
    const before = pre.get(b.accountIndex)?.amount ?? 0n;
    tokenDeltas.push({
      account: keys.get(b.accountIndex)!.toBase58(),
      owner: b.owner ?? null,
      mint: b.mint,
      delta: BigInt(b.uiTokenAmount.amount) - before,
    });
  }
  for (const [idx, b] of pre) {
    if (!seen.has(idx))
      tokenDeltas.push({
        account: keys.get(idx)!.toBase58(),
        owner: b.owner,
        mint: b.mint,
        delta: -b.amount,
      });
  }
  return {
    signature,
    slot: tx.slot,
    blockTime: tx.blockTime ?? null,
    wallet: keys.get(0)!.toBase58(),
    failed: tx.meta?.err != null,
    launchlab: launchlabEvents[0] ?? null,
    cpmm: cpmmEvents[0] ?? null,
    launchlabEvents,
    cpmmEvents,
    tokenDeltas,
    accountKeys: keys
      .keySegments()
      .flat()
      .map((k) => k.toBase58()),
  };
}

/** Membaca transaksi trade yang sudah mendarat dan mengurai event fee-nya. */
export async function readOnChainTrade(
  connection: Connection,
  signature: string,
  platform: Pick<PlatformAddresses, "launchlabProgram" | "cpmmProgram">,
): Promise<OnChainTrade | null> {
  const tx = await connection.getTransaction(signature, {
    commitment: "confirmed",
    maxSupportedTransactionVersion: 0,
  });
  if (!tx) return null;
  return parseTradeTransaction(tx, signature, {
    launchlab: platform.launchlabProgram,
    cpmm: platform.cpmmProgram,
  });
}

/** Rute yang dipakai transaksi on-chain (untuk receipt). */
export function routeOf(trade: OnChainTrade): TradeRoute | null {
  if (trade.launchlab) return "launchlab";
  if (trade.cpmm) return "cpmm";
  return null;
}

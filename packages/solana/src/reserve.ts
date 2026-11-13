/**
 * Transaksi Conviction Reserve (Tahap 8, Spec §11–13, §20C).
 *
 * Kustodi per token (MVP Spec §13 "segregated custody accounts", bukan program vault):
 *  - sisi quote: akun token `createWithSeed(master, "rq" + mint[0..30], program token quote)`;
 *  - sisi token: akun token `createWithSeed(master, "rt" + mint[0..30], program token mint)`.
 * Program = SPL Token klasik (token lama) atau Token-2022 (token baru / quote xStocks); alamat
 * ikut program pemilik akun, jadi selalu diturunkan bersama program mint-nya.
 * Alamat deterministik dari mint token, sehingga siapa pun bisa menurunkan ulang & memeriksa
 * saldonya. Authority akun = master wallet; penggunaannya dibatasi allowlist signer (hanya swap +
 * deposit ke pool CPMM token yang sama, LP langsung dibakar). Kepercayaan lebih lemah daripada
 * program vault on-chain: key master secara teknis tetap bisa memindahkan dana di luar signer.
 *
 * Deployment = SATU transaksi atomik (tidak ada keadaan setengah jadi):
 *   swap_base_input quote→token (dari/ke akun kustodi token itu)
 *   → deposit ke pool CPMM yang sama (LP ke ATA LP master)
 *   → SPL Burn seluruh LP hasil deposit (tidak bisa ditarik siapa pun) → close ATA LP.
 * Modul ini tidak memegang key; transaksi ditandatangani apps/signer.
 */
import { createHash } from "node:crypto";
import {
  getPdaPoolAuthority,
  makeDepositCpmmInInstruction,
  makeSwapCpmmBaseInInstruction,
} from "@raydium-io/raydium-sdk-v2";
import { PublicKey, SystemProgram, TransactionInstruction } from "@solana/web3.js";
import BN from "bn.js";
import { BPS_DENOMINATOR } from "@liftoff/shared";
import {
  budgetIxs,
  burnIx,
  compile,
  cpmmProgram,
  type BuiltEconomicTx,
  type EconomicTxEnv,
} from "./economic";
import {
  associatedTokenAddress,
  closeAccountIx,
  createAtaIdempotentIx,
  type Market,
} from "./trade";
import { TOKEN_PROGRAM } from "./token-program";

/** Ukuran akun token SPL (tanpa ekstensi). */
export const TOKEN_ACCOUNT_SPACE = 165;
/** Discriminator Anchor `deposit` program cp-swap (diverifikasi terhadap SDK Raydium). */
export const CPMM_DEPOSIT = "f223c68952e1f2b6";
export const SPL_TRANSFER = 3;
export const SPL_TRANSFER_CHECKED = 12;
export const SPL_INITIALIZE_ACCOUNT3 = 18;
/** SystemProgram CreateAccountWithSeed (indeks instruksi 3). */
export const SYSTEM_CREATE_WITH_SEED = 3;
export const SYSTEM_PROGRAM = SystemProgram.programId.toBase58();

/** Posisi akun instruksi deposit CPMM (urutan builder SDK Raydium 0.2.74-alpha). */
export const CPMM_DEPOSIT_ACCOUNTS = {
  owner: 0,
  pool: 2,
  ownerLp: 3,
  token0: 4,
  token1: 5,
  vault0Mint: 10,
  vault1Mint: 11,
  lpMint: 12,
};

export type ReserveSide = "quote" | "token";

/** Seed kustodi (≤ 32 byte): prefix sisi + 30 karakter pertama mint token. */
export function reserveSeed(side: ReserveSide, tokenMint: string): string {
  return `${side === "quote" ? "rq" : "rt"}${tokenMint.slice(0, 30)}`;
}

/** PublicKey.createWithSeed versi sinkron: sha256(base || seed || owner). */
export function addressWithSeed(base: string, seed: string, owner: string): string {
  const hash = createHash("sha256")
    .update(new PublicKey(base).toBuffer())
    .update(Buffer.from(seed, "utf8"))
    .update(new PublicKey(owner).toBuffer())
    .digest();
  return new PublicKey(hash).toBase58();
}

export interface ReserveVaultAddresses {
  quoteAccount: string;
  quoteSeed: string;
  tokenAccount: string;
  tokenSeed: string;
}

/** Program token tiap sisi kustodi (default SPL klasik = token lama). */
export interface ReservePrograms {
  quote: string;
  token: string;
}

export const LEGACY_RESERVE_PROGRAMS: ReservePrograms = {
  quote: TOKEN_PROGRAM,
  token: TOKEN_PROGRAM,
};

export function reserveVaultAddresses(
  master: string,
  tokenMint: string,
  programs: Partial<ReservePrograms> = {},
): ReserveVaultAddresses {
  const quoteSeed = reserveSeed("quote", tokenMint);
  const tokenSeed = reserveSeed("token", tokenMint);
  return {
    quoteAccount: addressWithSeed(master, quoteSeed, programs.quote ?? TOKEN_PROGRAM),
    quoteSeed,
    tokenAccount: addressWithSeed(master, tokenSeed, programs.token ?? TOKEN_PROGRAM),
    tokenSeed,
  };
}

/** createAccountWithSeed (master = payer & base) + InitializeAccount3 (owner master). */
function createCustodyIxs(
  master: string,
  account: string,
  seed: string,
  mint: string,
  rentLamports: number,
  tokenProgram: string,
): TransactionInstruction[] {
  const data = Buffer.alloc(33);
  data[0] = SPL_INITIALIZE_ACCOUNT3;
  new PublicKey(master).toBuffer().copy(data, 1);
  return [
    SystemProgram.createAccountWithSeed({
      fromPubkey: new PublicKey(master),
      newAccountPubkey: new PublicKey(account),
      basePubkey: new PublicKey(master),
      seed,
      lamports: rentLamports,
      space: TOKEN_ACCOUNT_SPACE,
      programId: new PublicKey(tokenProgram),
    }),
    new TransactionInstruction({
      programId: new PublicKey(tokenProgram),
      keys: [
        { pubkey: new PublicKey(account), isSigner: false, isWritable: true },
        { pubkey: new PublicKey(mint), isSigner: false, isWritable: false },
      ],
      data,
    }),
  ];
}

function transferIx(
  source: string,
  destination: string,
  owner: string,
  amount: bigint,
  tokenProgram: string,
) {
  const data = Buffer.alloc(9);
  data[0] = SPL_TRANSFER;
  data.writeBigUInt64LE(amount, 1);
  return new TransactionInstruction({
    programId: new PublicKey(tokenProgram),
    keys: [
      { pubkey: new PublicKey(source), isSigner: false, isWritable: true },
      { pubkey: new PublicKey(destination), isSigner: false, isWritable: true },
      { pubkey: new PublicKey(owner), isSigner: true, isWritable: false },
    ],
    data,
  });
}

/**
 * Memindahkan reserve token itu dari ATA quote master ke akun kustodi quote token itu (dibuat
 * bila belum ada). Untuk WSOL: akun baru berisi tepat rent → saldo token awal 0.
 */
export async function buildReserveFundTx(
  env: EconomicTxEnv,
  p: {
    tokenMint: string;
    quoteMint: string;
    amount: bigint;
    createAccount: boolean;
    /** Default SPL klasik (token lama). */
    programs?: ReservePrograms;
  },
): Promise<BuiltEconomicTx> {
  const master = env.platform.masterWallet;
  const programs = p.programs ?? LEGACY_RESERVE_PROGRAMS;
  const qp = programs.quote;
  const v = reserveVaultAddresses(master, p.tokenMint, programs);
  const ixs = [...budgetIxs(env)];
  if (p.createAccount) {
    const rent = await env.connection.getMinimumBalanceForRentExemption(TOKEN_ACCOUNT_SPACE);
    ixs.push(...createCustodyIxs(master, v.quoteAccount, v.quoteSeed, p.quoteMint, rent, qp));
  }
  ixs.push(
    transferIx(
      associatedTokenAddress(master, p.quoteMint, qp),
      v.quoteAccount,
      master,
      p.amount,
      qp,
    ),
  );
  return compile(env, ixs);
}

// ------------------------------------------------------------------ deployment

type CpmmMarket = Extract<Market, { route: "cpmm" }>;

export interface ReservePoolMetrics {
  pool: string;
  lpMint: string;
  /** Total LP pool (state `lpAmount`, termasuk LP yang terbakar saat migrasi). */
  lpSupply: bigint;
  reserveToken: bigint;
  reserveQuote: bigint;
  tokenDecimals: number;
  quoteDecimals: number;
  /** Quote per 1 token (unit tampilan) dari cadangan pool. */
  spotPrice: number;
  /** Status pool cp-swap: bit 0 deposit, bit 1 withdraw, bit 2 swap dinonaktifkan. */
  status: number;
  depositEnabled: boolean;
  swapEnabled: boolean;
  /** Quote yang dibutuhkan untuk menaikkan harga +2% (kedalaman, Spec §11 Phase 2). */
  depth2PctQuote: bigint;
}

export function poolMetrics(m: CpmmMarket, tokenMint: string): ReservePoolMetrics {
  const tokenIsA = m.pool.mintA.toBase58() === tokenMint;
  const [reserveToken, reserveQuote] = tokenIsA
    ? [m.reserveA, m.reserveB]
    : [m.reserveB, m.reserveA];
  const tokenDecimals = tokenIsA ? m.pool.mintDecimalA : m.pool.mintDecimalB;
  const quoteDecimals = tokenIsA ? m.pool.mintDecimalB : m.pool.mintDecimalA;
  const status = Number(m.pool.status);
  const spot =
    reserveToken > 0n
      ? Number(reserveQuote) / 10 ** quoteDecimals / (Number(reserveToken) / 10 ** tokenDecimals)
      : 0;
  // x·y = k: harga naik 2% ⇔ quote pool × √1,02 → Δquote = quote × (√1,02 − 1) ≈ 0,995%.
  const depth2PctQuote = (reserveQuote * 9_950n) / 1_000_000n;
  return {
    pool: m.poolId,
    lpMint: m.pool.mintLp.toBase58(),
    lpSupply: BigInt(m.pool.lpAmount.toString()),
    reserveToken,
    reserveQuote,
    tokenDecimals,
    quoteDecimals,
    spotPrice: spot,
    status,
    depositEnabled: (status & 1) === 0,
    swapEnabled: (status & 4) === 0,
    depth2PctQuote,
  };
}

export interface ReserveDeployPlan {
  pool: string;
  lpMint: string;
  /** Batas quote deployment (25% saldo, dsb.); total yang keluar ≤ nilai ini. */
  deployQuote: bigint;
  swapIn: bigint;
  swapExpectedOut: bigint;
  swapMinOut: bigint;
  lpAmount: bigint;
  maxQuote: bigint;
  maxToken: bigint;
  priceImpactBps: number;
}

/**
 * Rencana deployment dari state pool saat ini (fungsi murni). Separuh quote ditukar ke token,
 * lalu LP dihitung dari jumlah yang DIJAMIN (minOut swap, sisa quote) dengan margin slippage:
 * deposit tidak pernah meminta lebih dari yang ada di akun kustodi. Sisa kecil tetap di kustodi.
 */
export function planReserveDeploy(p: {
  metrics: ReservePoolMetrics;
  deployQuote: bigint;
  swapExpectedOut: bigint;
  swapMinOut: bigint;
  priceImpactBps: number;
  slippageBps: number;
}): ReserveDeployPlan {
  const m = p.metrics;
  const swapIn = p.deployQuote / 2n;
  const maxQuote = p.deployQuote - swapIn;
  const maxToken = p.swapMinOut;
  if (swapIn <= 0n || maxToken <= 0n) throw new Error("jumlah deployment terlalu kecil");
  // Cadangan sesudah swap (batas atas sisi quote, batas bawah sisi token).
  const quoteAfter = m.reserveQuote + swapIn;
  const tokenAfter = m.reserveToken - p.swapExpectedOut;
  if (tokenAfter <= 0n) throw new Error("cadangan token pool tidak cukup");
  const byToken = (maxToken * m.lpSupply) / tokenAfter;
  const byQuote = (maxQuote * m.lpSupply) / quoteAfter;
  const raw = byToken < byQuote ? byToken : byQuote;
  const lpAmount = (raw * BigInt(BPS_DENOMINATOR - p.slippageBps)) / BigInt(BPS_DENOMINATOR);
  if (lpAmount <= 0n) throw new Error("LP hasil deployment 0 (jumlah terlalu kecil)");
  return {
    pool: m.pool,
    lpMint: m.lpMint,
    deployQuote: p.deployQuote,
    swapIn,
    swapExpectedOut: p.swapExpectedOut,
    swapMinOut: p.swapMinOut,
    lpAmount,
    maxQuote,
    maxToken,
    priceImpactBps: p.priceImpactBps,
  };
}

/**
 * Transaksi deployment atomik. Nominal (swapIn/minOut/lpAmount/max) PERSIS dari rencana yang
 * disimpan di economic_ops (dicek signer); state pool dibaca segar hanya untuk akun.
 */
export async function buildReserveDeployTx(
  env: EconomicTxEnv,
  p: {
    tokenMint: string;
    quoteMint: string;
    market: CpmmMarket;
    plan: Pick<ReserveDeployPlan, "swapIn" | "swapMinOut" | "lpAmount" | "maxQuote" | "maxToken">;
    createTokenAccount: boolean;
    closeLpAccount: boolean;
  },
): Promise<BuiltEconomicTx> {
  const master = env.platform.masterWallet;
  const m = p.market;
  const program = cpmmProgram(env);
  const authority = getPdaPoolAuthority(program).publicKey;
  const v = reserveVaultAddresses(master, p.tokenMint, m.programs);
  const lpMint = m.pool.mintLp.toBase58();
  const lpAta = associatedTokenAddress(master, lpMint);
  const quoteIsA = m.pool.mintA.toBase58() === p.quoteMint;
  const ixs = [...budgetIxs(env)];
  if (p.createTokenAccount) {
    const rent = await env.connection.getMinimumBalanceForRentExemption(TOKEN_ACCOUNT_SPACE);
    ixs.push(
      ...createCustodyIxs(master, v.tokenAccount, v.tokenSeed, p.tokenMint, rent, m.programs.token),
    );
  }
  ixs.push(createAtaIdempotentIx(master, lpAta, master, lpMint));
  ixs.push(
    makeSwapCpmmBaseInInstruction(
      program,
      new PublicKey(master),
      authority,
      m.pool.configId,
      new PublicKey(m.poolId),
      new PublicKey(v.quoteAccount),
      new PublicKey(v.tokenAccount),
      quoteIsA ? m.pool.vaultA : m.pool.vaultB,
      quoteIsA ? m.pool.vaultB : m.pool.vaultA,
      quoteIsA ? m.pool.mintProgramA : m.pool.mintProgramB,
      quoteIsA ? m.pool.mintProgramB : m.pool.mintProgramA,
      new PublicKey(p.quoteMint),
      new PublicKey(p.tokenMint),
      m.pool.observationId,
      new BN(p.plan.swapIn.toString()),
      new BN(p.plan.swapMinOut.toString()),
    ),
  );
  const [userA, userB] = quoteIsA
    ? [v.quoteAccount, v.tokenAccount]
    : [v.tokenAccount, v.quoteAccount];
  const [maxA, maxB] = quoteIsA
    ? [p.plan.maxQuote, p.plan.maxToken]
    : [p.plan.maxToken, p.plan.maxQuote];
  ixs.push(
    makeDepositCpmmInInstruction(
      program,
      new PublicKey(master),
      authority,
      new PublicKey(m.poolId),
      new PublicKey(lpAta),
      new PublicKey(userA),
      new PublicKey(userB),
      m.pool.vaultA,
      m.pool.vaultB,
      m.pool.mintA,
      m.pool.mintB,
      m.pool.mintLp,
      new BN(p.plan.lpAmount.toString()),
      new BN(maxA.toString()),
      new BN(maxB.toString()),
    ),
  );
  ixs.push(burnIx(lpAta, lpMint, master, p.plan.lpAmount));
  if (p.closeLpAccount) ixs.push(closeAccountIx(lpAta, master, master));
  return compile(env, ixs);
}

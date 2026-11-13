/**
 * Transaksi economic engine (Tahap 7, Spec §9, §20A–B): claim creator fee, buyback, burn.
 *
 * Semua transaksi dibangun UNSIGNED dengan fee payer = master wallet; worker mengirimnya ke
 * apps/signer yang memeriksa allowlist (policy.ts) + simulasi sebelum menandatangani. Modul ini
 * tidak memegang key apa pun.
 *
 * Dana ekonomi tetap berbentuk token quote di ATA master (WSOL untuk pair SOL): claim masuk ke
 * ATA itu, buyback membelanjakan dari ATA itu, tidak ada wrap/unwrap SOL native. Dengan begitu
 * SOL operasional (gas) tidak tercampur dengan dana buyback/reserve.
 */
import {
  claimCreatorFee,
  CpmmPoolInfoLayout,
  getPdaCreatorFeeVaultAuth,
  getPdaPoolAuthority,
  makeCollectCreatorFeeInstruction,
} from "@raydium-io/raydium-sdk-v2";
import type { TransactionInstruction } from "@solana/web3.js";
import {
  ComputeBudgetProgram,
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
  type Connection,
} from "@solana/web3.js";
import type { PlatformAddresses, TradeQuote } from "@liftoff/shared";
import { creatorFeeVault } from "./stonkfun";
import {
  associatedTokenAddress,
  closeAccountIx,
  createAtaIdempotentIx,
  parseTradeTransaction,
  swapInstruction,
  type Market,
  type ParsedTradeTransaction,
  type TradeEnv,
  type TradeTarget,
} from "./trade";
import { burnIx, mintProgramOf } from "./token-program";
import { encodeTransaction } from "./tx-inspect";

export { burnIx } from "./token-program";

/** Discriminator Anchor (8 byte pertama data instruksi), diverifikasi terhadap SDK Raydium. */
export const LAUNCHLAB_CLAIM_CREATOR_FEE = "1a618acb84ab8dfc";
export const LAUNCHLAB_BUY_EXACT_IN = "faea0d7bd59c13ec";
export const CPMM_SWAP_BASE_INPUT = "8fbe5adac41e33de";
export const CPMM_COLLECT_CREATOR_FEE = "1416567bc61cdb84";

/** Posisi akun instruksi (diverifikasi terhadap builder SDK Raydium 0.2.74-alpha). */
export const CLAIM_CREATOR_FEE_ACCOUNTS = { creator: 0, auth: 1, vault: 2, recipient: 3, mint: 4 };
export const BUY_EXACT_IN_ACCOUNTS = {
  owner: 0,
  platform: 3,
  pool: 4,
  userToken: 5,
  userQuote: 6,
  mintA: 9,
  mintB: 10,
  creatorVault: 17,
};
export const CPMM_SWAP_ACCOUNTS = {
  payer: 0,
  pool: 3,
  userIn: 4,
  userOut: 5,
  mintIn: 10,
  mintOut: 11,
};
export const CPMM_COLLECT_ACCOUNTS = {
  creator: 0,
  pool: 2,
  mintA: 6,
  mintB: 7,
  ownerA: 8,
  ownerB: 9,
};

/** SPL Token & Token-2022 (tag sama): Burn (8), BurnChecked (15), CloseAccount (9). */
export const SPL_BURN = 8;
export const SPL_BURN_CHECKED = 15;
export const SPL_CLOSE_ACCOUNT = 9;
export const ASSOCIATED_TOKEN_PROGRAM_ID = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";

export interface EconomicTxEnv {
  connection: Connection;
  platform: PlatformAddresses;
  computeUnitLimit: number;
  computeUnitPriceMicroLamports: number;
}

export interface BuiltEconomicTx {
  /** VersionedTransaction unsigned (base64). */
  transaction: string;
  lastValidBlockHeight: number;
}

export function cpmmProgram(env: Pick<EconomicTxEnv, "platform">) {
  return new PublicKey(env.platform.cpmmProgram);
}

export function budgetIxs(env: EconomicTxEnv): TransactionInstruction[] {
  const ixs = [ComputeBudgetProgram.setComputeUnitLimit({ units: env.computeUnitLimit })];
  if (env.computeUnitPriceMicroLamports > 0) {
    ixs.push(
      ComputeBudgetProgram.setComputeUnitPrice({
        microLamports: env.computeUnitPriceMicroLamports,
      }),
    );
  }
  return ixs;
}

export async function compile(
  env: EconomicTxEnv,
  ixs: TransactionInstruction[],
): Promise<BuiltEconomicTx> {
  const latest = await env.connection.getLatestBlockhash("confirmed");
  const message = new TransactionMessage({
    payerKey: new PublicKey(env.platform.masterWallet),
    recentBlockhash: latest.blockhash,
    instructions: ixs,
  }).compileToV0Message();
  return {
    transaction: encodeTransaction(new VersionedTransaction(message)),
    lastValidBlockHeight: latest.lastValidBlockHeight,
  };
}

/** Saldo akun token SPL; 0 bila akun belum ada. */
export async function tokenAccountBalance(
  connection: Connection,
  account: string,
): Promise<bigint> {
  const info = await connection.getAccountInfo(new PublicKey(account), "confirmed");
  if (!info || info.data.length < 72) return 0n;
  return info.data.readBigUInt64LE(64);
}

// ------------------------------------------------------------------ claim

/** Vault creator curve LaunchLab (agregat semua token master wallet untuk quote mint ini). */
export async function readCurveClaimable(env: EconomicTxEnv, quoteMint: string) {
  const vault = creatorFeeVault(env.platform, quoteMint);
  return { vault, amount: await tokenAccountBalance(env.connection, vault) };
}

export async function buildClaimCurveTx(env: EconomicTxEnv, quoteMint: string) {
  const master = env.platform.masterWallet;
  const program = new PublicKey(env.platform.launchlabProgram);
  // Quote Token-2022 (xStocks): ATA & instruksi memakai program token milik mint itu.
  const quoteProgram = await mintProgramOf(env.connection, quoteMint);
  const recipient = associatedTokenAddress(master, quoteMint, quoteProgram);
  return compile(env, [
    ...budgetIxs(env),
    createAtaIdempotentIx(master, recipient, master, quoteMint, quoteProgram),
    claimCreatorFee(
      program,
      new PublicKey(master),
      getPdaCreatorFeeVaultAuth(program).publicKey,
      new PublicKey(creatorFeeVault(env.platform, quoteMint)),
      new PublicKey(recipient),
      new PublicKey(quoteMint),
      new PublicKey(quoteProgram),
    ),
  ]);
}

export interface CpmmClaimable {
  pool: string;
  poolCreator: string;
  enableCreatorFee: boolean;
  mintA: string;
  mintB: string;
  /** Creator fee belum di-claim per sisi pool. */
  feesA: bigint;
  feesB: bigint;
}

export async function readCpmmClaimable(
  env: Pick<EconomicTxEnv, "connection" | "platform">,
  pool: string,
): Promise<CpmmClaimable | null> {
  const info = await env.connection.getAccountInfo(new PublicKey(pool), "confirmed");
  if (!info || !info.owner.equals(cpmmProgram(env))) return null;
  const s = CpmmPoolInfoLayout.decode(info.data);
  return {
    pool,
    poolCreator: s.poolCreator.toBase58(),
    enableCreatorFee: s.enableCreatorFee,
    mintA: s.mintA.toBase58(),
    mintB: s.mintB.toBase58(),
    feesA: BigInt(s.creatorFeesMintA.toString()),
    feesB: BigInt(s.creatorFeesMintB.toString()),
  };
}

export async function buildClaimCpmmTx(env: EconomicTxEnv, pool: string) {
  const info = await env.connection.getAccountInfo(new PublicKey(pool), "confirmed");
  if (!info) throw new Error(`pool CPMM ${pool} tidak ditemukan`);
  const s = CpmmPoolInfoLayout.decode(info.data);
  const master = env.platform.masterWallet;
  const program = cpmmProgram(env);
  const ownerA = associatedTokenAddress(master, s.mintA.toBase58(), s.mintProgramA.toBase58());
  const ownerB = associatedTokenAddress(master, s.mintB.toBase58(), s.mintProgramB.toBase58());
  return compile(env, [
    ...budgetIxs(env),
    createAtaIdempotentIx(master, ownerA, master, s.mintA.toBase58(), s.mintProgramA.toBase58()),
    createAtaIdempotentIx(master, ownerB, master, s.mintB.toBase58(), s.mintProgramB.toBase58()),
    makeCollectCreatorFeeInstruction(
      program,
      new PublicKey(master),
      getPdaPoolAuthority(program).publicKey,
      new PublicKey(pool),
      s.configId,
      s.vaultA,
      s.vaultB,
      s.mintA,
      s.mintB,
      new PublicKey(ownerA),
      new PublicKey(ownerB),
      s.mintProgramA,
      s.mintProgramB,
    ),
  ]);
}

// ------------------------------------------------------------------ buyback & burn

/**
 * Buyback token itu sendiri: swap exact-in dari ATA quote master ke ATA token master, di curve
 * LaunchLab (sebelum graduate) atau pool CPMM hasil migrasi (sesudahnya). minOut dari quote
 * (batas slippage). Tanpa referral (share fee 0).
 */
export async function buildBuybackTx(
  env: EconomicTxEnv,
  t: TradeTarget,
  market: Market,
  quote: TradeQuote,
) {
  const master = env.platform.masterWallet;
  const tradeEnv: TradeEnv = {
    connection: env.connection,
    platform: env.platform,
    referralWallet: null,
    graduatedRoute: "cpmm",
  };
  const userToken = associatedTokenAddress(master, t.mint, market.programs.token);
  const userQuote = associatedTokenAddress(master, t.pair.mint, market.programs.quote);
  return compile(env, [
    ...budgetIxs(env),
    createAtaIdempotentIx(master, userToken, master, t.mint, market.programs.token),
    swapInstruction(tradeEnv, t, market, quote, master, userQuote, userToken),
  ]);
}

/**
 * Burn SEMUA token hasil satu buyback dari ATA token master. Bila saldo ATA = jumlah burn, ATA
 * ikut ditutup sehingga rent-nya kembali ke master (program menolak close bila saldo tersisa).
 */
export async function buildBurnTx(
  env: EconomicTxEnv,
  mint: string,
  amount: bigint,
  closeAccount: boolean,
) {
  const master = env.platform.masterWallet;
  // Token baru = Token-2022 (syarat adopsi StonkFun), token lama = SPL klasik.
  const program = await mintProgramOf(env.connection, mint);
  const ata = associatedTokenAddress(master, mint, program);
  const ixs = [...budgetIxs(env), burnIx(ata, mint, master, amount, program)];
  if (closeAccount) ixs.push(closeAccountIx(ata, master, master, program));
  return compile(env, ixs);
}

/** Transaksi economic engine yang sudah mendarat (Δ saldo token per akun, event trade). */
export async function readLandedTx(
  connection: Connection,
  signature: string,
  platform: Pick<PlatformAddresses, "launchlabProgram" | "cpmmProgram">,
): Promise<ParsedTradeTransaction | null> {
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

/** Δ saldo token akun tertentu di transaksi (0 bila tidak tercatat). */
export function deltaOf(tx: ParsedTradeTransaction, account: string): bigint {
  return tx.tokenDeltas.filter((d) => d.account === account).reduce((a, d) => a + d.delta, 0n);
}

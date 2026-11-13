/**
 * Token-2022 (syarat adopsi StonkFun): launch `initialize_with_token2022`, buyback & burn dengan
 * ATA/instruksi Token-2022, kustodi reserve untuk quote Token-2022 (xStocks). Program token tiap
 * mint diberikan signer (dibaca on-chain di service.ts), bukan diambil dari transaksi.
 */
import {
  buyExactInInstruction,
  getPdaLaunchpadAuth,
  getPdaLaunchpadPoolId,
  getPdaLaunchpadVaultId,
  getPdaPlatformVault,
  initializeWithToken2022,
} from "@raydium-io/raydium-sdk-v2";
import { decodeTransaction, inspectTransaction } from "@liftoff/solana";
import { launchAccountPdas, launchPoolAddress } from "@liftoff/solana/launchlab";
import { buildReserveFundTx, reserveVaultAddresses } from "@liftoff/solana/reserve";
import { creatorFeeVault } from "@liftoff/solana/stonkfun";
import {
  associatedTokenAddress,
  burnIx,
  closeAccountIx,
  createAtaIdempotentIx,
  TOKEN_2022_PROGRAM,
  TOKEN_PROGRAM,
} from "@liftoff/solana/token-program";
import {
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
  type Connection,
  type TransactionInstruction,
} from "@solana/web3.js";
import BN from "bn.js";
import { describe, expect, it } from "vitest";
import { checkBurnPolicy, checkBuybackPolicy, type PolicyOp } from "./economic-policy";
import { checkLaunchPolicy } from "./policy";
import { checkReserveFundPolicy } from "./reserve-policy";
import { BLOCKHASH, SOL_PAIR, testSetup } from "./test-helpers";
import { platformFor as platformOf } from "@liftoff/shared";

const CPMM_PROGRAM = platformOf("devnet").cpmmProgram;

const SOL = SOL_PAIR.mint;
const pk = (s: string) => new PublicKey(s);
const T22 = { token: TOKEN_2022_PROGRAM, quote: TOKEN_PROGRAM };

function compile(payer: PublicKey, ixs: TransactionInstruction[]) {
  const message = new TransactionMessage({
    payerKey: payer,
    recentBlockhash: BLOCKHASH,
    instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), ...ixs],
  }).compileToV0Message();
  return new VersionedTransaction(message);
}

describe("Token-2022 — allowlist signer", () => {
  const { master, platform, config } = testSetup();
  const m = master.publicKey.toBase58();

  const pdas = launchAccountPdas(platform.launchlabProgram, platform.platformId, SOL_PAIR.configId);
  /** Create Token-2022 dengan akun tambahan opsional (allow-config, curve-rule) dari SDK. */
  function createIx(mint: PublicKey, allowConfig?: string, curveRule?: string) {
    const program = pk(platform.launchlabProgram);
    const poolId = getPdaLaunchpadPoolId(program, mint, pk(SOL)).publicKey;
    return initializeWithToken2022(
      program,
      master.publicKey,
      master.publicKey,
      pk(SOL_PAIR.configId),
      pk(platform.platformId),
      getPdaLaunchpadAuth(program).publicKey,
      poolId,
      mint,
      pk(SOL),
      getPdaLaunchpadVaultId(program, poolId, mint).publicKey,
      getPdaLaunchpadVaultId(program, poolId, pk(SOL)).publicKey,
      pk(TOKEN_PROGRAM),
      6,
      "Test",
      "TST",
      "https://example.invalid/m.json",
      {
        type: "ConstantCurve",
        totalSellA: new BN("793100000000000"),
        migrateType: "cpmm",
        supply: new BN("1000000000000000"),
        totalFundRaisingB: new BN(80_000_000_000),
      },
      new BN(0),
      new BN(0),
      new BN(0),
      0,
      undefined,
      allowConfig ? pk(allowConfig) : undefined,
      curveRule ? pk(curveRule) : undefined,
    );
  }

  it("launch initialize_with_token2022 (builder SDK, allow-config lalu curve-rule terakhir) diizinkan", () => {
    const mint = Keypair.generate().publicKey;
    const ix = createIx(mint, pdas.allowConfigId, pdas.curveRuleId);
    const tx = compile(master.publicKey, [ix]);
    const input = {
      platform,
      mint: mint.toBase58(),
      pool: launchPoolAddress(platform, mint.toBase58(), SOL),
      configId: SOL_PAIR.configId,
      maxTipLamports: config.maxTipLamports,
    };
    expect(checkLaunchPolicy({ tx: inspectTransaction(tx), ...input })).toEqual([]);
    // Mint lain (bukan turunan job) tetap ditolak.
    expect(
      checkLaunchPolicy({
        tx: inspectTransaction(tx),
        ...input,
        mint: Keypair.generate().publicKey.toBase58(),
      }).join(),
    ).toMatch(/mint/);
  });

  it("akun tambahan create: PDA turunan signer, urutan allow-config → curve-rule, read-only", () => {
    const mint = Keypair.generate().publicKey;
    const input = {
      platform,
      mint: mint.toBase58(),
      pool: launchPoolAddress(platform, mint.toBase58(), SOL),
      configId: SOL_PAIR.configId,
      maxTipLamports: config.maxTipLamports,
    };
    const check = (ix: TransactionInstruction) =>
      checkLaunchPolicy({ tx: inspectTransaction(compile(master.publicKey, [ix])), ...input });
    // Tanpa akun tambahan / hanya salah satu → diizinkan.
    expect(check(createIx(mint))).toEqual([]);
    expect(check(createIx(mint, pdas.allowConfigId))).toEqual([]);
    expect(check(createIx(mint, undefined, pdas.curveRuleId))).toEqual([]);
    const ix = createIx(mint, pdas.allowConfigId, pdas.curveRuleId);
    expect(ix.keys.slice(-2).map((k) => k.pubkey.toBase58())).toEqual([
      pdas.allowConfigId,
      pdas.curveRuleId,
    ]);
    // Urutan terbalik (curve-rule bukan terakhir).
    expect(check(createIx(mint, pdas.curveRuleId, pdas.allowConfigId)).join()).toMatch(/urutan/);
    // Alamat bukan PDA platform/config (mis. dari API yang salah) → ditolak.
    const fake = Keypair.generate().publicKey.toBase58();
    expect(check(createIx(mint, fake, pdas.curveRuleId)).join()).toMatch(/bukan PDA/);
    // PDA untuk config lain → ditolak.
    const other = launchAccountPdas(
      platform.launchlabProgram,
      platform.platformId,
      Keypair.generate().publicKey.toBase58(),
    );
    expect(check(createIx(mint, other.allowConfigId)).join()).toMatch(/bukan PDA/);
    // Writable → ditolak.
    const writable = createIx(mint, pdas.allowConfigId);
    writable.keys[writable.keys.length - 1]!.isWritable = true;
    expect(check(writable).join()).toMatch(/read-only/);
    // Akun ketiga apa pun → ditolak.
    const extra = createIx(mint, pdas.allowConfigId, pdas.curveRuleId);
    extra.keys.push({ pubkey: pk(fake), isSigner: false, isWritable: false });
    expect(check(extra).join()).toMatch(/bukan PDA/);
  });

  it("buyback token Token-2022: ATA token di program Token-2022; ATA SPL lama ditolak", () => {
    const mint = Keypair.generate().publicKey.toBase58();
    const program = pk(platform.launchlabProgram);
    const buy = (userToken: string, tokenProgram: string) =>
      compile(master.publicKey, [
        createAtaIdempotentIx(m, userToken, m, mint, tokenProgram),
        buyExactInInstruction(
          program,
          master.publicKey,
          getPdaLaunchpadAuth(program).publicKey,
          pk(SOL_PAIR.configId),
          pk(platform.platformId),
          pk(launchPoolAddress(platform, mint, SOL)),
          pk(userToken),
          pk(associatedTokenAddress(m, SOL)),
          Keypair.generate().publicKey,
          Keypair.generate().publicKey,
          pk(mint),
          pk(SOL),
          pk(tokenProgram),
          pk(TOKEN_PROGRAM),
          getPdaPlatformVault(program, pk(platform.platformId), pk(SOL)).publicKey,
          pk(creatorFeeVault(platform, SOL)),
          new BN(16_000),
          new BN(15_000_000),
          new BN(0),
          undefined,
        ),
      ]);
    const op: PolicyOp = {
      kind: "buyback",
      tokenMint: mint,
      assetMint: SOL,
      target: mint,
      amountIn: 16_000n,
      minOut: 15_000_000n,
    };
    const check = (tx: VersionedTransaction) =>
      checkBuybackPolicy({
        tx: inspectTransaction(tx),
        platform,
        cpmmProgram: CPMM_PROGRAM,
        op,
        launchPool: launchPoolAddress(platform, mint, SOL),
        cpmmPool: null,
        programs: T22,
      });
    const ata2022 = associatedTokenAddress(m, mint, TOKEN_2022_PROGRAM);
    expect(check(buy(ata2022, TOKEN_2022_PROGRAM))).toEqual([]);
    const ataSpl = associatedTokenAddress(m, mint, TOKEN_PROGRAM);
    expect(check(buy(ataSpl, TOKEN_PROGRAM)).join()).toMatch(/akun token/);
  });

  it("burn Token-2022: Burn + CloseAccount di program Token-2022; program salah ditolak", () => {
    const mint = Keypair.generate().publicKey.toBase58();
    const ata = associatedTokenAddress(m, mint, TOKEN_2022_PROGRAM);
    const op: PolicyOp = {
      kind: "burn",
      tokenMint: mint,
      assetMint: mint,
      target: ata,
      amountIn: 500n,
      minOut: null,
    };
    const tx = compile(master.publicKey, [
      burnIx(ata, mint, m, 500n, TOKEN_2022_PROGRAM),
      closeAccountIx(ata, m, m, TOKEN_2022_PROGRAM),
    ]);
    expect(
      checkBurnPolicy({
        tx: inspectTransaction(tx),
        master: m,
        op,
        tokenProgram: TOKEN_2022_PROGRAM,
      }),
    ).toEqual([]);
    // Signer membaca mint sebagai Token-2022: instruksi program SPL klasik tidak diizinkan.
    const spl = compile(master.publicKey, [burnIx(ata, mint, m, 500n, TOKEN_PROGRAM)]);
    expect(
      checkBurnPolicy({
        tx: inspectTransaction(spl),
        master: m,
        op,
        tokenProgram: TOKEN_2022_PROGRAM,
      }).join(),
    ).toMatch(/tidak diizinkan|harus tepat 1/);
  });

  it("reserve_fund quote Token-2022 (xStocks): kustodi & transfer di program Token-2022", async () => {
    const connection = {
      getLatestBlockhash: async () => ({ blockhash: BLOCKHASH, lastValidBlockHeight: 1_000 }),
      getMinimumBalanceForRentExemption: async () => 2_039_280,
    } as unknown as Connection;
    const token = Keypair.generate().publicKey.toBase58();
    const xstock = Keypair.generate().publicKey.toBase58();
    const programs = { quote: TOKEN_2022_PROGRAM, token: TOKEN_2022_PROGRAM };
    const built = await buildReserveFundTx(
      { connection, platform, computeUnitLimit: 300_000, computeUnitPriceMicroLamports: 0 },
      { tokenMint: token, quoteMint: xstock, amount: 7_000n, createAccount: true, programs },
    );
    const inspected = inspectTransaction(decodeTransaction(built.transaction), []);
    const vault = reserveVaultAddresses(m, token, programs);
    expect(vault.quoteAccount).not.toBe(reserveVaultAddresses(m, token).quoteAccount);
    const op: PolicyOp = {
      kind: "reserve_fund",
      tokenMint: token,
      assetMint: xstock,
      target: vault.quoteAccount,
      amountIn: 7_000n,
      minOut: null,
    };
    expect(checkReserveFundPolicy({ tx: inspected, master: m, op, programs })).toEqual([]);
    // Signer menganggap quote SPL klasik → alamat & program tidak cocok → ditolak.
    expect(checkReserveFundPolicy({ tx: inspected, master: m, op })).not.toEqual([]);
  });
});

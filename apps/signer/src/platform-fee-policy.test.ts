import { bpsToRaydiumRate, FEE_CONFIG, platformFor } from "@liftoff/shared";
import { inspectTransaction } from "@liftoff/solana";
import {
  buildPlatformFeeRateIx,
  buildPlatformFeeSyncIx,
  decodeUpdateAllData,
  LAUNCHLAB_UPDATE_PLATFORM_CONFIG,
  type PlatformUpdateAllArgs,
} from "@liftoff/solana/launchlab";
import {
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { checkPlatformFeePolicy, checkPlatformFeeSyncPolicy } from "./policy";

const platform = platformFor("devnet");
const target = bpsToRaydiumRate(FEE_CONFIG.platformFeeBps);
const master = new PublicKey(platform.masterWallet);

function txOf(ixs: TransactionInstruction[], payer = master) {
  return inspectTransaction(
    new VersionedTransaction(
      new TransactionMessage({
        payerKey: payer,
        recentBlockhash: "11111111111111111111111111111111",
        instructions: ixs,
      }).compileToV0Message(),
    ),
  );
}

const check = (ixs: TransactionInstruction[], payer?: PublicKey, targetRate = target) =>
  checkPlatformFeePolicy({ tx: txOf(ixs, payer), platform, targetRate });

describe("checkPlatformFeePolicy", () => {
  it("discriminator sama dengan builder SDK", () => {
    const ix = buildPlatformFeeRateIx(platform, target);
    expect(Buffer.from(ix.data).subarray(0, 8).toString("hex")).toBe(
      LAUNCHLAB_UPDATE_PLATFORM_CONFIG,
    );
  });

  it("menerima updateFeeRate = FEE_CONFIG (+ compute budget)", () => {
    expect(check([buildPlatformFeeRateIx(platform, target)])).toEqual([]);
    expect(
      check([
        ComputeBudgetProgram.setComputeUnitLimit({ units: 50_000 }),
        buildPlatformFeeRateIx(platform, target),
      ]),
    ).toEqual([]);
  });

  it("menolak nilai selain target, di atas batas program, atau payer lain", () => {
    expect(check([buildPlatformFeeRateIx(platform, target + 1)]).join()).toMatch(/≠ target/);
    expect(check([buildPlatformFeeRateIx(platform, 60_000)], undefined, 60_000).join()).toMatch(
      /melebihi batas/,
    );
    const other = Keypair.generate().publicKey;
    expect(check([buildPlatformFeeRateIx(platform, target)], other).join()).toMatch(/fee payer/);
  });

  it("menolak varian update lain dan instruksi tambahan", () => {
    const ix = buildPlatformFeeRateIx(platform, target);
    const otherVariant = new TransactionInstruction({
      programId: ix.programId,
      keys: ix.keys,
      data: Buffer.concat([
        Buffer.from(ix.data).subarray(0, 8),
        Buffer.from([0]),
        master.toBuffer(),
      ]),
    });
    expect(check([otherVariant]).join()).toMatch(/updateFeeRate/);
    const drain = SystemProgram.transfer({
      fromPubkey: master,
      toPubkey: Keypair.generate().publicKey,
      lamports: 1,
    });
    expect(check([ix, drain]).join()).toMatch(/tidak diizinkan/);
    expect(check([ix, ix]).join()).toMatch(/tepat 1/);
  });
});

describe("checkPlatformFeeSyncPolicy (platform + creator fee, updateAll)", () => {
  const current: PlatformUpdateAllArgs = {
    platformClaimFeeWallet: platform.masterWallet,
    platformLockNftWallet: platform.masterWallet,
    platformScale: 500_000n,
    creatorScale: 0n,
    burnScale: 500_000n,
    feeRate: 30_000n,
    name: "LIFTOFF devnet PoC",
    web: "https://example.invalid/liftoff",
    img: "https://example.invalid/liftoff.png",
    transferFeeExtensionAuth: platform.masterWallet,
    creatorFeeRate: 0n,
    platformVestingScale: 0n,
    platformVestingWallet: platform.masterWallet,
    cpConfigId: "5MxLgy9oPdTC3YgkiePHqr3EoCRD9uLVYRQS2ANAs7wy",
  };
  const goal = {
    feeRate: bpsToRaydiumRate(FEE_CONFIG.platformFeeBps),
    creatorFeeRate: bpsToRaydiumRate(FEE_CONFIG.creatorFeeBps),
  };
  const ixFor = (over: Partial<PlatformUpdateAllArgs> = {}) =>
    buildPlatformFeeSyncIx(platform, {
      ...current,
      feeRate: BigInt(goal.feeRate),
      creatorFeeRate: BigInt(goal.creatorFeeRate),
      ...over,
    });
  const sync = (ixs: TransactionInstruction[], target = goal) =>
    checkPlatformFeeSyncPolicy({ tx: txOf(ixs), platform, current, target });

  it("decoder membaca kembali data builder SDK", () => {
    const decoded = decodeUpdateAllData(Buffer.from(ixFor().data));
    expect(decoded).toMatchObject({ feeRate: 10_000n, creatorFeeRate: 5_000n, name: current.name });
  });

  it("menerima target FEE_CONFIG (1% platform, 0,5% creator) dengan bidang lain identik", () => {
    expect(goal).toEqual({ feeRate: 10_000, creatorFeeRate: 5_000 });
    expect(sync([ixFor()])).toEqual([]);
  });

  it("menolak pengalihan wallet claim / LP NFT / cpConfig dan nilai selain target", () => {
    const attacker = Keypair.generate().publicKey.toBase58();
    expect(sync([ixFor({ platformClaimFeeWallet: attacker })]).join()).toMatch(
      /platformClaimFeeWallet berubah/,
    );
    expect(sync([ixFor({ platformLockNftWallet: attacker })]).join()).toMatch(/LockNftWallet/);
    expect(sync([ixFor({ cpConfigId: attacker })]).join()).toMatch(/cpConfigId berubah/);
    expect(sync([ixFor({ burnScale: 0n })]).join()).toMatch(/burnScale/);
    expect(sync([ixFor({ creatorFeeRate: 4_000n })]).join()).toMatch(/creatorFeeRate/);
  });

  it("menolak target di atas batas program dan varian lain", () => {
    expect(
      sync([ixFor({ creatorFeeRate: 6_000n })], { ...goal, creatorFeeRate: 6_000 }).join(),
    ).toMatch(/melebihi batas/);
    expect(sync([buildPlatformFeeRateIx(platform, goal.feeRate)]).join()).toMatch(/updateAll/);
    const drain = SystemProgram.transfer({
      fromPubkey: master,
      toPubkey: Keypair.generate().publicKey,
      lamports: 1,
    });
    expect(sync([ixFor(), drain]).join()).toMatch(/tidak diizinkan/);
  });
});

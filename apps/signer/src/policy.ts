/**
 * Allowlist program & instruksi per tujuan tanda tangan (fungsi murni, diuji tabel).
 *
 * Hanya instruksi yang dibutuhkan yang diizinkan. Tujuan economic engine Tahap 7 (claim creator
 * fee, buyback curve/CPMM, burn SPL Token) ada di economic-policy.ts.
 */
import {
  bpsToRaydiumRate,
  JITO_TIP_ACCOUNTS,
  LAUNCHLAB_MAX_CREATOR_FEE_BPS,
  LAUNCHLAB_MAX_PLATFORM_FEE_BPS,
  type PlatformAddresses,
} from "@liftoff/shared";
import type { InspectedInstruction, InspectedTransaction } from "@liftoff/solana";
import { ASSOCIATED_TOKEN_PROGRAM } from "@liftoff/solana/token-program";
import {
  decodeUpdateAllData,
  launchAccountPdas,
  LAUNCHLAB_INIT_ACCOUNTS,
  LAUNCHLAB_INIT_FIXED_ACCOUNTS,
  LAUNCHLAB_INITIALIZE_TOKEN2022,
  LAUNCHLAB_INITIALIZE_V2,
  LAUNCHLAB_UPDATE_PLATFORM_CONFIG,
  PLATFORM_UPDATE_FEE_RATE_INDEX,
  type PlatformUpdateAllArgs,
} from "@liftoff/solana/launchlab";

export const SYSTEM_PROGRAM = "11111111111111111111111111111111";
export const COMPUTE_BUDGET_PROGRAM = "ComputeBudget111111111111111111111111111111";

/** Instruksi System `Transfer` (indeks 2): u32 LE tag + u64 LE lamport. */
export function decodeSystemTransfer(ix: InspectedInstruction) {
  const data = Buffer.from(ix.dataHex, "hex");
  if (ix.programId !== SYSTEM_PROGRAM || data.length !== 12 || data.readUInt32LE(0) !== 2) {
    return null;
  }
  const [from, to] = ix.accounts;
  if (!from || !to) return null;
  return { from, to, lamports: data.readBigUInt64LE(4) };
}

/** ComputeBudget: hanya SetComputeUnitLimit (2) dan SetComputeUnitPrice (3). */
export function isAllowedComputeBudget(ix: InspectedInstruction): boolean {
  const tag = Buffer.from(ix.dataHex, "hex")[0];
  return ix.programId === COMPUTE_BUDGET_PROGRAM && (tag === 2 || tag === 3);
}

export function signerChecks(
  tx: InspectedTransaction,
  master: string,
  allowed: string[],
): string[] {
  const v: string[] = [];
  if (tx.feePayer !== master) v.push(`fee payer ${tx.feePayer} bukan master wallet`);
  for (const s of tx.requiredSigners) {
    if (!allowed.includes(s)) v.push(`signer tak dikenal diminta: ${s}`);
  }
  for (const s of allowed) {
    if (!tx.requiredSigners.includes(s)) v.push(`signer wajib tidak ada di transaksi: ${s}`);
  }
  return v;
}

export interface LaunchPolicyInput {
  tx: InspectedTransaction;
  platform: PlatformAddresses;
  /** Mint yang diturunkan signer untuk job ini. */
  mint: string;
  /** Pool PDA yang diharapkan (mint + quote mint pair job). */
  pool: string;
  /** Global config LaunchLab pair job. */
  configId: string;
  maxTipLamports: number;
  /** ATA quote master yang boleh dibuat bersama launch pair non-SOL. null = tidak boleh ada. */
  quoteAta?: { ata: string; mint: string } | null;
}

/** ATA `CreateIdempotent` (tag 1): pembayar & pemilik master, untuk akun & mint yang tepat. */
function isMasterQuoteAtaCreate(
  ix: InspectedInstruction,
  master: string,
  q: { ata: string; mint: string },
): boolean {
  const [payer, ata, owner, mint] = ix.accounts;
  return (
    ix.programId === ASSOCIATED_TOKEN_PROGRAM &&
    ix.dataHex === "01" &&
    payer === master &&
    ata === q.ata &&
    owner === master &&
    mint === q.mint
  );
}

export function checkLaunchPolicy(p: LaunchPolicyInput): string[] {
  const master = p.platform.masterWallet;
  const v = signerChecks(p.tx, master, [master, p.mint]);
  let creates = 0;
  let tips = 0;
  for (const ix of p.tx.instructions) {
    if (ix.programId === p.platform.launchlabProgram) {
      // initialize_v2 (SPL klasik) atau initialize_with_token2022 (token baru, syarat StonkFun).
      if (
        !ix.dataHex.startsWith(LAUNCHLAB_INITIALIZE_V2) &&
        !ix.dataHex.startsWith(LAUNCHLAB_INITIALIZE_TOKEN2022)
      ) {
        v.push(
          "instruksi LaunchLab selain initialize_v2/initialize_with_token2022 tidak diizinkan",
        );
        continue;
      }
      creates++;
      const a = LAUNCHLAB_INIT_ACCOUNTS;
      const expect: Array<[string, string | undefined, string]> = [
        ["payer", ix.accounts[a.payer], master],
        ["creator", ix.accounts[a.creator], master],
        ["platform", ix.accounts[a.platform], p.platform.platformId],
        ["pool", ix.accounts[a.pool], p.pool],
        ["mint", ix.accounts[a.mint], p.mint],
      ];
      for (const [name, got, want] of expect) {
        if (got !== want) v.push(`LaunchLab ${name} = ${got ?? "-"}, harus ${want}`);
      }
      if (!ix.accounts.includes(p.configId)) v.push("global config pair tidak dirujuk");
      v.push(...launchExtraAccountViolations(ix, p));
      continue;
    }
    if (isAllowedComputeBudget(ix)) continue;
    if (p.quoteAta && isMasterQuoteAtaCreate(ix, master, p.quoteAta)) continue;
    const transfer = decodeSystemTransfer(ix);
    if (transfer && transfer.from === master && JITO_TIP_ACCOUNTS.includes(transfer.to)) {
      tips++;
      if (transfer.lamports > BigInt(p.maxTipLamports)) {
        v.push(`tip Jito ${transfer.lamports} melebihi batas ${p.maxTipLamports}`);
      }
      continue;
    }
    v.push(`instruksi tidak diizinkan: program ${ix.programId}`);
  }
  if (creates !== 1) v.push(`harus tepat 1 instruksi create LaunchLab, ada ${creates}`);
  if (tips > 1) v.push("lebih dari satu tip Jito");
  return v;
}

/**
 * Akun sesudah akun tetap create hanya boleh: allow-config lalu curve-rule (keduanya opsional,
 * urutan StonkFun, curve-rule selalu terakhir), read-only, dan masing-masing WAJIB sama dengan
 * PDA yang diturunkan signer sendiri dari Platform PDA + global config pair job.
 */
function launchExtraAccountViolations(ix: InspectedInstruction, p: LaunchPolicyInput): string[] {
  const fixed = LAUNCHLAB_INIT_FIXED_ACCOUNTS[ix.dataHex.slice(0, 16)]!;
  const extras = ix.accounts.slice(fixed);
  if (extras.length === 0) return [];
  const pdas = launchAccountPdas(p.platform.launchlabProgram, p.platform.platformId, p.configId);
  const allowed = [pdas.allowConfigId, pdas.curveRuleId];
  const v: string[] = [];
  let next = 0;
  for (const [i, acc] of extras.entries()) {
    const at = allowed.indexOf(acc, next);
    if (at < 0) {
      v.push(
        allowed.includes(acc)
          ? "urutan akun tambahan create salah (allow-config harus sebelum curve-rule)"
          : `akun tambahan create ${acc} bukan PDA allow-config/curve-rule platform`,
      );
      continue;
    }
    next = at + 1;
    if (ix.writable[fixed + i]) v.push(`akun tambahan create ${acc} harus read-only`);
  }
  return v;
}

export interface RefundPolicyInput {
  tx: InspectedTransaction;
  master: string;
  /** Penerima yang diizinkan = pembayar deposit yang tercatat di DB. */
  recipient: string;
  lamports: bigint;
}

export function checkRefundPolicy(p: RefundPolicyInput): string[] {
  const v = signerChecks(p.tx, p.master, [p.master]);
  let transfers = 0;
  for (const ix of p.tx.instructions) {
    if (isAllowedComputeBudget(ix)) continue;
    const t = decodeSystemTransfer(ix);
    if (!t) {
      v.push(`instruksi tidak diizinkan untuk refund: program ${ix.programId}`);
      continue;
    }
    transfers++;
    if (t.from !== p.master) v.push("refund harus dari master wallet");
    if (t.to !== p.recipient) v.push(`penerima ${t.to} tidak ada di allowlist (pembayar deposit)`);
    if (t.lamports !== p.lamports) v.push(`jumlah refund ${t.lamports} ≠ deposit ${p.lamports}`);
  }
  if (transfers !== 1) v.push(`harus tepat 1 transfer refund, ada ${transfers}`);
  return v;
}

export interface PlatformFeePolicyInput {
  tx: InspectedTransaction;
  platform: PlatformAddresses;
  /** feeRate (per 1_000_000) yang diizinkan = FEE_CONFIG.platformFeeBps dikonversi. */
  targetRate: number;
}

/**
 * Perubahan platform fee (operator, Tahap 5): hanya `update_platform_config` varian
 * `updateFeeRate` pada Platform PDA LIFTOFF, admin = master, nilai PERSIS target dari
 * FEE_CONFIG dan ≤ batas program. Varian lain (wallet claim, cpConfig, dst.) ditolak.
 */
export function checkPlatformFeePolicy(p: PlatformFeePolicyInput): string[] {
  const master = p.platform.masterWallet;
  const v = signerChecks(p.tx, master, [master]);
  if (!Number.isInteger(p.targetRate) || p.targetRate < 0) v.push("target feeRate tidak valid");
  if (p.targetRate > bpsToRaydiumRate(LAUNCHLAB_MAX_PLATFORM_FEE_BPS)) {
    v.push(`target feeRate ${p.targetRate} melebihi batas program`);
  }
  let updates = 0;
  for (const ix of p.tx.instructions) {
    if (ix.programId === p.platform.launchlabProgram) {
      if (!ix.dataHex.startsWith(LAUNCHLAB_UPDATE_PLATFORM_CONFIG)) {
        v.push("instruksi LaunchLab selain update_platform_config tidak diizinkan");
        continue;
      }
      updates++;
      const data = Buffer.from(ix.dataHex, "hex");
      if (data.length !== 8 + 1 + 8 || data[8] !== PLATFORM_UPDATE_FEE_RATE_INDEX) {
        v.push("hanya varian updateFeeRate yang diizinkan");
        continue;
      }
      const rate = data.readBigUInt64LE(9);
      if (rate !== BigInt(p.targetRate)) v.push(`feeRate ${rate} ≠ target ${p.targetRate}`);
      if (ix.accounts[0] !== master) v.push("admin platform harus master wallet");
      if (ix.accounts[1] !== p.platform.platformId) v.push("platform bukan Platform PDA LIFTOFF");
      continue;
    }
    if (isAllowedComputeBudget(ix)) continue;
    v.push(`instruksi tidak diizinkan: program ${ix.programId}`);
  }
  if (updates !== 1) v.push(`harus tepat 1 instruksi update_platform_config, ada ${updates}`);
  return v;
}

export interface PlatformFeeSyncPolicyInput {
  tx: InspectedTransaction;
  platform: PlatformAddresses;
  /** State Platform PDA on-chain saat ini (dibaca signer, bukan dari pemanggil). */
  current: PlatformUpdateAllArgs;
  /** Rate target (per 1_000_000) = FEE_CONFIG dikonversi. */
  target: { feeRate: number; creatorFeeRate: number };
}

/**
 * Sinkron platform fee + creator fee (Spec §9–10, operator): hanya `update_platform_config`
 * varian `updateAll` pada Platform PDA LIFTOFF, admin = master. Program tidak punya varian khusus
 * creator fee, jadi SEMUA bidang lain wajib identik dengan state on-chain — wallet claim/LP NFT/
 * vesting, skala LP, nama, web, img, cpConfigId tidak bisa dibelokkan lewat jalur ini.
 */
export function checkPlatformFeeSyncPolicy(p: PlatformFeeSyncPolicyInput): string[] {
  const master = p.platform.masterWallet;
  const v = signerChecks(p.tx, master, [master]);
  const { feeRate, creatorFeeRate } = p.target;
  for (const [name, rate, max] of [
    ["feeRate", feeRate, bpsToRaydiumRate(LAUNCHLAB_MAX_PLATFORM_FEE_BPS)],
    ["creatorFeeRate", creatorFeeRate, bpsToRaydiumRate(LAUNCHLAB_MAX_CREATOR_FEE_BPS)],
  ] as const) {
    if (!Number.isInteger(rate) || rate < 0) v.push(`target ${name} tidak valid`);
    if (rate > max) v.push(`target ${name} ${rate} melebihi batas program ${max}`);
  }
  let updates = 0;
  for (const ix of p.tx.instructions) {
    if (ix.programId === p.platform.launchlabProgram) {
      if (!ix.dataHex.startsWith(LAUNCHLAB_UPDATE_PLATFORM_CONFIG)) {
        v.push("instruksi LaunchLab selain update_platform_config tidak diizinkan");
        continue;
      }
      updates++;
      const args = decodeUpdateAllData(Buffer.from(ix.dataHex, "hex"));
      if (!args) {
        v.push("hanya varian updateAll yang diizinkan untuk sinkron fee");
        continue;
      }
      if (args.feeRate !== BigInt(feeRate)) v.push(`feeRate ${args.feeRate} ≠ target ${feeRate}`);
      if (args.creatorFeeRate !== BigInt(creatorFeeRate)) {
        v.push(`creatorFeeRate ${args.creatorFeeRate} ≠ target ${creatorFeeRate}`);
      }
      for (const key of Object.keys(args) as Array<keyof typeof args>) {
        if (key === "feeRate" || key === "creatorFeeRate") continue;
        if (args[key] !== p.current[key]) v.push(`${key} berubah (harus sama dengan on-chain)`);
      }
      if (ix.accounts[0] !== master) v.push("admin platform harus master wallet");
      if (ix.accounts[1] !== p.platform.platformId) v.push("platform bukan Platform PDA LIFTOFF");
      if (ix.accounts[2] !== p.current.cpConfigId) v.push("cpConfigId berubah");
      if (ix.accounts.length !== 3) v.push("jumlah akun updateAll tidak sesuai");
      continue;
    }
    if (isAllowedComputeBudget(ix)) continue;
    v.push(`instruksi tidak diizinkan: program ${ix.programId}`);
  }
  if (updates !== 1) v.push(`harus tepat 1 instruksi update_platform_config, ada ${updates}`);
  return v;
}

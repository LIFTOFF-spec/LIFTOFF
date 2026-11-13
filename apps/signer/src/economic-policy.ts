/**
 * Allowlist economic engine (Tahap 7, Spec §9, Requirement 8): claim creator fee, buyback token
 * itu sendiri, burn hasil buyback. Fungsi murni, diuji tabel.
 *
 * Prinsip: semua dana tetap di akun milik master wallet atau masuk pool resmi token itu.
 *  - claim: hanya ke ATA quote master; vault/pool harus milik token LIFTOFF (creator = master);
 *  - buyback: hanya swap exact-in dari ATA quote master ke ATA token master, di pool resmi token
 *    (curve LaunchLab platform LIFTOFF / pool CPMM hasil migrasinya), nominal & minOut PERSIS
 *    sama dengan baris economic_ops (budget dicek dari ledger oleh service), tanpa referral;
 *  - burn: hanya Burn jumlah persis dari ATA token master (+ CloseAccount ke master), di program
 *    token milik mint itu (SPL klasik untuk token lama, Token-2022 untuk token baru).
 * Program token tiap mint dibaca signer on-chain (service.ts), bukan dari transaksi.
 * Tidak ada transfer SOL/token ke pihak lain di jalur mana pun.
 */
import type { EconomicOpKind, PlatformAddresses } from "@liftoff/shared";
import type { InspectedInstruction, InspectedTransaction } from "@liftoff/solana";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  BUY_EXACT_IN_ACCOUNTS,
  CLAIM_CREATOR_FEE_ACCOUNTS,
  CPMM_COLLECT_ACCOUNTS,
  CPMM_COLLECT_CREATOR_FEE,
  CPMM_SWAP_ACCOUNTS,
  CPMM_SWAP_BASE_INPUT,
  LAUNCHLAB_BUY_EXACT_IN,
  LAUNCHLAB_CLAIM_CREATOR_FEE,
  SPL_BURN,
  SPL_BURN_CHECKED,
  SPL_CLOSE_ACCOUNT,
} from "@liftoff/solana/economic";
import { creatorFeeVault } from "@liftoff/solana/stonkfun";
import {
  associatedTokenAddress,
  isAssociatedTokenAddressOf,
  isTokenProgram,
  TOKEN_PROGRAM,
} from "@liftoff/solana/token-program";
import { isAllowedComputeBudget, signerChecks } from "./policy";

/** Bagian baris economic_ops yang relevan untuk policy (nominal sebagai bigint). */
export interface PolicyOp {
  kind: EconomicOpKind;
  tokenMint: string | null;
  assetMint: string;
  target: string;
  amountIn: bigint | null;
  minOut: bigint | null;
}

/** ATA CreateIdempotent/Create oleh master untuk (master, mint yang diizinkan). */
function isAllowedAtaCreate(ix: InspectedInstruction, master: string, mints: string[]): boolean {
  if (ix.programId !== ASSOCIATED_TOKEN_PROGRAM_ID) return false;
  const tag = ix.dataHex === "" ? 0 : Buffer.from(ix.dataHex, "hex")[0];
  if (tag !== 0 && tag !== 1) return false;
  const [payer, ata, owner, mint, , tokenProgram] = ix.accounts;
  if (payer !== master || owner !== master || !mint || !mints.includes(mint)) return false;
  const program = tokenProgram ?? TOKEN_PROGRAM;
  return isTokenProgram(program) && ata === associatedTokenAddress(master, mint, program);
}

function u64At(dataHex: string, offset: number): bigint | null {
  const data = Buffer.from(dataHex, "hex");
  return data.length >= offset + 8 ? data.readBigUInt64LE(offset) : null;
}

export interface FeeClaimPolicyInput {
  tx: InspectedTransaction;
  platform: PlatformAddresses;
  cpmmProgram: string;
  op: PolicyOp;
  /** Program token quote mint (dibaca on-chain). Default SPL klasik. */
  quoteProgram?: string;
}

export function checkFeeClaimPolicy(p: FeeClaimPolicyInput): string[] {
  const master = p.platform.masterWallet;
  const v = signerChecks(p.tx, master, [master]);
  const { op } = p;
  let claims = 0;
  const ataMints: string[] = [];
  if (op.kind === "claim_curve") {
    const vault = creatorFeeVault(p.platform, op.assetMint);
    if (op.target !== vault) v.push("target claim bukan vault creator master untuk quote mint ini");
    ataMints.push(op.assetMint);
    for (const ix of p.tx.instructions) {
      if (ix.programId === p.platform.launchlabProgram) {
        if (!ix.dataHex.startsWith(LAUNCHLAB_CLAIM_CREATOR_FEE)) {
          v.push("instruksi LaunchLab selain claim_creator_fee tidak diizinkan");
          continue;
        }
        claims++;
        const a = CLAIM_CREATOR_FEE_ACCOUNTS;
        const expect: Array<[string, string | undefined, string]> = [
          ["creator", ix.accounts[a.creator], master],
          ["vault", ix.accounts[a.vault], vault],
          [
            "recipient",
            ix.accounts[a.recipient],
            associatedTokenAddress(master, op.assetMint, p.quoteProgram ?? TOKEN_PROGRAM),
          ],
          ["mint", ix.accounts[a.mint], op.assetMint],
        ];
        for (const [name, got, want] of expect) {
          if (got !== want) v.push(`claim ${name} = ${got ?? "-"}, harus ${want}`);
        }
        continue;
      }
      if (isAllowedComputeBudget(ix) || isAllowedAtaCreate(ix, master, ataMints)) continue;
      v.push(`instruksi tidak diizinkan untuk claim: program ${ix.programId}`);
    }
  } else if (op.kind === "claim_cpmm") {
    if (!op.tokenMint) v.push("claim CPMM butuh token");
    for (const ix of p.tx.instructions) {
      if (ix.programId === p.cpmmProgram) {
        if (!ix.dataHex.startsWith(CPMM_COLLECT_CREATOR_FEE)) {
          v.push("instruksi CPMM selain collect_creator_fee tidak diizinkan");
          continue;
        }
        claims++;
        const a = CPMM_COLLECT_ACCOUNTS;
        const mintA = ix.accounts[a.mintA] ?? "";
        const mintB = ix.accounts[a.mintB] ?? "";
        if (ix.accounts[a.creator] !== master) v.push("creator pool harus master wallet");
        if (ix.accounts[a.pool] !== op.target) v.push("pool bukan target operasi");
        const pair = [mintA, mintB];
        if (!op.tokenMint || !pair.includes(op.tokenMint) || !pair.includes(op.assetMint)) {
          v.push("pasangan mint pool bukan token + quote operasi");
        }
        // Owner token account = ATA master (dibuat bila perlu oleh instruksi ATA di depan).
        for (const [side, mint] of [
          [a.ownerA, mintA],
          [a.ownerB, mintB],
        ] as const) {
          const got = ix.accounts[side];
          const ok = !!got && isAssociatedTokenAddressOf(got, master, mint);
          if (!ok) v.push(`penerima fee CPMM ${got ?? "-"} bukan ATA master`);
        }
        ataMints.push(mintA, mintB);
        continue;
      }
      if (isAllowedComputeBudget(ix)) continue;
      if (ix.programId === ASSOCIATED_TOKEN_PROGRAM_ID) continue; // dicek setelah mint diketahui
      v.push(`instruksi tidak diizinkan untuk claim: program ${ix.programId}`);
    }
    for (const ix of p.tx.instructions) {
      if (
        ix.programId === ASSOCIATED_TOKEN_PROGRAM_ID &&
        !isAllowedAtaCreate(ix, master, ataMints)
      ) {
        v.push("instruksi ATA tidak diizinkan (bukan ATA master untuk mint pool)");
      }
    }
  } else {
    v.push(`jenis operasi ${op.kind} bukan claim`);
  }
  if (claims !== 1) v.push(`harus tepat 1 instruksi claim, ada ${claims}`);
  return v;
}

export interface BuybackPolicyInput {
  tx: InspectedTransaction;
  platform: PlatformAddresses;
  cpmmProgram: string;
  op: PolicyOp;
  /** Pool resmi token yang diturunkan signer: curve LaunchLab dan pool CPMM hasil migrasi. */
  launchPool: string;
  cpmmPool: string | null;
  /** Program token mint token & quote (dibaca on-chain). Default SPL klasik. */
  programs?: { token: string; quote: string };
}

export function checkBuybackPolicy(p: BuybackPolicyInput): string[] {
  const master = p.platform.masterWallet;
  const v = signerChecks(p.tx, master, [master]);
  const { op } = p;
  if (op.kind !== "buyback") v.push(`jenis operasi ${op.kind} bukan buyback`);
  if (!op.tokenMint) return [...v, "buyback butuh token"];
  if (!op.amountIn || op.amountIn <= 0n) v.push("amountIn buyback harus > 0");
  if (!op.minOut || op.minOut <= 0n) v.push("minOut buyback harus > 0 (batas slippage wajib)");
  const userToken = associatedTokenAddress(master, op.tokenMint, p.programs?.token);
  const userQuote = associatedTokenAddress(master, op.assetMint, p.programs?.quote);
  let swaps = 0;
  for (const ix of p.tx.instructions) {
    if (ix.programId === p.platform.launchlabProgram) {
      if (!ix.dataHex.startsWith(LAUNCHLAB_BUY_EXACT_IN)) {
        v.push("instruksi LaunchLab selain buy_exact_in tidak diizinkan");
        continue;
      }
      swaps++;
      const a = BUY_EXACT_IN_ACCOUNTS;
      const expect: Array<[string, string | undefined, string]> = [
        ["owner", ix.accounts[a.owner], master],
        ["platform", ix.accounts[a.platform], p.platform.platformId],
        ["pool", ix.accounts[a.pool], p.launchPool],
        ["akun token", ix.accounts[a.userToken], userToken],
        ["akun quote", ix.accounts[a.userQuote], userQuote],
        ["mintA", ix.accounts[a.mintA], op.tokenMint],
        ["mintB", ix.accounts[a.mintB], op.assetMint],
        ["vault creator", ix.accounts[a.creatorVault], creatorFeeVault(p.platform, op.assetMint)],
      ];
      for (const [name, got, want] of expect) {
        if (got !== want) v.push(`buyback ${name} = ${got ?? "-"}, harus ${want}`);
      }
      if (ix.accounts.length !== 18) v.push("akun share fee (referral) tidak diizinkan");
      const amount = u64At(ix.dataHex, 8);
      const minOut = u64At(ix.dataHex, 16);
      const share = u64At(ix.dataHex, 24);
      if (amount !== op.amountIn) v.push(`amountIn ${amount} ≠ operasi ${op.amountIn}`);
      if (minOut !== op.minOut) v.push(`minOut ${minOut} ≠ operasi ${op.minOut}`);
      if (share !== 0n) v.push("share fee rate harus 0");
      continue;
    }
    if (ix.programId === p.cpmmProgram) {
      if (!ix.dataHex.startsWith(CPMM_SWAP_BASE_INPUT)) {
        v.push("instruksi CPMM selain swap_base_input tidak diizinkan");
        continue;
      }
      swaps++;
      const a = CPMM_SWAP_ACCOUNTS;
      if (!p.cpmmPool) v.push("token belum punya pool CPMM hasil migrasi");
      const expect: Array<[string, string | undefined, string]> = [
        ["payer", ix.accounts[a.payer], master],
        ["pool", ix.accounts[a.pool], p.cpmmPool ?? "-"],
        ["akun input", ix.accounts[a.userIn], userQuote],
        ["akun output", ix.accounts[a.userOut], userToken],
        ["mint input", ix.accounts[a.mintIn], op.assetMint],
        ["mint output", ix.accounts[a.mintOut], op.tokenMint],
      ];
      for (const [name, got, want] of expect) {
        if (got !== want) v.push(`buyback ${name} = ${got ?? "-"}, harus ${want}`);
      }
      const amount = u64At(ix.dataHex, 8);
      const minOut = u64At(ix.dataHex, 16);
      if (amount !== op.amountIn) v.push(`amountIn ${amount} ≠ operasi ${op.amountIn}`);
      if (minOut !== op.minOut) v.push(`minOut ${minOut} ≠ operasi ${op.minOut}`);
      continue;
    }
    if (isAllowedComputeBudget(ix) || isAllowedAtaCreate(ix, master, [op.tokenMint])) continue;
    v.push(`instruksi tidak diizinkan untuk buyback: program ${ix.programId}`);
  }
  if (swaps !== 1) v.push(`harus tepat 1 instruksi swap, ada ${swaps}`);
  return v;
}

export interface BurnPolicyInput {
  tx: InspectedTransaction;
  master: string;
  op: PolicyOp;
  /** Program token mint yang dibakar (dibaca on-chain). Default SPL klasik. */
  tokenProgram?: string;
}

export function checkBurnPolicy(p: BurnPolicyInput): string[] {
  const v = signerChecks(p.tx, p.master, [p.master]);
  const { op } = p;
  if (op.kind !== "burn") v.push(`jenis operasi ${op.kind} bukan burn`);
  if (!op.tokenMint) return [...v, "burn butuh token"];
  if (!op.amountIn || op.amountIn <= 0n) v.push("jumlah burn harus > 0");
  const program = p.tokenProgram ?? TOKEN_PROGRAM;
  const ata = associatedTokenAddress(p.master, op.tokenMint, program);
  if (op.target !== ata) v.push("target burn bukan ATA token master");
  let burns = 0;
  let closes = 0;
  for (const ix of p.tx.instructions) {
    if (ix.programId === program) {
      const data = Buffer.from(ix.dataHex, "hex");
      const tag = data[0];
      if (tag === SPL_BURN || tag === SPL_BURN_CHECKED) {
        burns++;
        const [account, mint, owner] = ix.accounts;
        if (account !== ata) v.push(`akun burn ${account ?? "-"} bukan ATA token master`);
        if (mint !== op.tokenMint) v.push("mint burn bukan token operasi");
        if (owner !== p.master) v.push("owner burn harus master wallet");
        const amount = data.length >= 9 ? data.readBigUInt64LE(1) : null;
        if (amount !== op.amountIn) v.push(`jumlah burn ${amount} ≠ operasi ${op.amountIn}`);
        continue;
      }
      if (tag === SPL_CLOSE_ACCOUNT) {
        closes++;
        const [account, destination, owner] = ix.accounts;
        if (account !== ata || destination !== p.master || owner !== p.master) {
          v.push("close account hanya untuk ATA token master, rent ke master");
        }
        continue;
      }
      v.push(`instruksi SPL Token ${tag} tidak diizinkan untuk burn`);
      continue;
    }
    if (isAllowedComputeBudget(ix)) continue;
    v.push(`instruksi tidak diizinkan untuk burn: program ${ix.programId}`);
  }
  if (burns !== 1) v.push(`harus tepat 1 instruksi burn, ada ${burns}`);
  if (closes > 1) v.push("lebih dari satu close account");
  return v;
}

/**
 * Allowlist Conviction Reserve (Tahap 8, Spec §11–13, Requirement 8, Rule 3). Fungsi murni.
 *
 *  - reserve_fund: hanya Transfer SPL jumlah PERSIS dari ATA quote master ke akun kustodi quote
 *    token itu (alamat createWithSeed dari mint token; boleh dibuat di transaksi yang sama);
 *  - reserve_deploy: hanya swap_base_input quote→token di pool CPMM hasil migrasi token itu, dari
 *    akun kustodi quote ke akun kustodi token token itu; deposit ke pool YANG SAMA dari kedua akun
 *    kustodi itu; SPL Burn seluruh LP hasil deposit dari ATA LP master; close ATA LP ke master.
 * Dana reserve token A tidak bisa menyentuh pool/akun token B: semua alamat diturunkan dari mint
 * operasi. Tidak ada transfer ke pihak lain di jalur mana pun.
 */
import type { InspectedInstruction, InspectedTransaction } from "@liftoff/solana";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  CPMM_SWAP_ACCOUNTS,
  CPMM_SWAP_BASE_INPUT,
  SPL_BURN,
  SPL_CLOSE_ACCOUNT,
} from "@liftoff/solana/economic";
import {
  CPMM_DEPOSIT,
  CPMM_DEPOSIT_ACCOUNTS,
  reserveVaultAddresses,
  SPL_INITIALIZE_ACCOUNT3,
  SPL_TRANSFER,
  SYSTEM_CREATE_WITH_SEED,
  SYSTEM_PROGRAM,
  TOKEN_ACCOUNT_SPACE,
} from "@liftoff/solana/reserve";
import { associatedTokenAddress, TOKEN_PROGRAM } from "@liftoff/solana/token-program";
import type { ReservePrograms } from "@liftoff/solana/reserve";
import { PublicKey } from "@solana/web3.js";
import type { PolicyOp } from "./economic-policy";
import { isAllowedComputeBudget, signerChecks } from "./policy";

/** Rent maksimum akun kustodi baru (rent akun token 165 byte ≈ 2.039.280 lamport). */
export const MAX_CUSTODY_RENT_LAMPORTS = 3_000_000n;

/** Rencana deployment yang disimpan di economic_ops.details (string desimal). */
export interface ReserveDeployPlanFields {
  swapIn: bigint;
  swapMinOut: bigint;
  lpAmount: bigint;
  maxQuote: bigint;
  maxToken: bigint;
}

const u64 = (data: Buffer, offset: number) =>
  data.length >= offset + 8 ? data.readBigUInt64LE(offset) : null;

interface CreateWithSeed {
  from: string;
  account: string;
  base: string;
  seed: string;
  lamports: bigint;
  space: bigint;
  owner: string;
}

/** Decode SystemProgram CreateAccountWithSeed; null bila bukan instruksi itu. */
export function decodeCreateWithSeed(ix: InspectedInstruction): CreateWithSeed | null {
  if (ix.programId !== SYSTEM_PROGRAM) return null;
  const d = Buffer.from(ix.dataHex, "hex");
  if (d.length < 4 || d.readUInt32LE(0) !== SYSTEM_CREATE_WITH_SEED) return null;
  const base = new PublicKey(d.subarray(4, 36)).toBase58();
  const len = Number(d.readBigUInt64LE(36));
  const seedEnd = 44 + len;
  if (d.length !== seedEnd + 48) return null;
  return {
    from: ix.accounts[0] ?? "",
    account: ix.accounts[1] ?? "",
    base,
    seed: d.subarray(44, seedEnd).toString("utf8"),
    lamports: d.readBigUInt64LE(seedEnd),
    space: d.readBigUInt64LE(seedEnd + 8),
    owner: new PublicKey(d.subarray(seedEnd + 16, seedEnd + 48)).toBase58(),
  };
}

/**
 * Pembuatan akun kustodi: CreateAccountWithSeed (master = from = base, seed persis, 165 byte,
 * owner Token Program, rent wajar) atau InitializeAccount3 (owner master, mint yang diharapkan).
 * Mengembalikan pelanggaran; [] bila instruksi sah. null bila bukan instruksi pembuatan akun.
 */
function checkCustodyCreate(
  ix: InspectedInstruction,
  master: string,
  account: string,
  seed: string,
  mint: string,
  tokenProgram: string,
): string[] | null {
  const create = decodeCreateWithSeed(ix);
  if (create) {
    const v: string[] = [];
    if (create.from !== master || create.base !== master)
      v.push("akun kustodi harus dibuat master");
    if (create.account !== account || create.seed !== seed)
      v.push(`akun kustodi ${create.account} bukan turunan seed token operasi`);
    if (create.space !== BigInt(TOKEN_ACCOUNT_SPACE) || create.owner !== tokenProgram)
      v.push("akun kustodi harus akun token 165 byte milik program token mint itu");
    if (create.lamports > MAX_CUSTODY_RENT_LAMPORTS) v.push("rent akun kustodi melebihi batas");
    return v;
  }
  if (ix.programId === tokenProgram) {
    const d = Buffer.from(ix.dataHex, "hex");
    if (d[0] !== SPL_INITIALIZE_ACCOUNT3) return null;
    const v: string[] = [];
    const owner = d.length === 33 ? new PublicKey(d.subarray(1, 33)).toBase58() : "";
    if (ix.accounts[0] !== account) v.push("inisialisasi akun selain akun kustodi");
    if (ix.accounts[1] !== mint) v.push("mint akun kustodi salah");
    if (owner !== master) v.push("owner akun kustodi harus master wallet");
    return v;
  }
  return null;
}

export interface ReserveFundPolicyInput {
  tx: InspectedTransaction;
  master: string;
  op: PolicyOp;
  /** Program token quote & token (dibaca on-chain oleh signer). Default SPL klasik. */
  programs?: ReservePrograms;
}

export function checkReserveFundPolicy(p: ReserveFundPolicyInput): string[] {
  const { master, op } = p;
  const v = signerChecks(p.tx, master, [master]);
  if (op.kind !== "reserve_fund") v.push(`jenis operasi ${op.kind} bukan reserve_fund`);
  if (!op.tokenMint) return [...v, "reserve_fund butuh token"];
  if (!op.amountIn || op.amountIn <= 0n) v.push("jumlah reserve_fund harus > 0");
  const quoteProgram = p.programs?.quote ?? TOKEN_PROGRAM;
  const vault = reserveVaultAddresses(master, op.tokenMint, p.programs);
  if (op.target !== vault.quoteAccount) v.push("target bukan akun kustodi quote token operasi");
  const source = associatedTokenAddress(master, op.assetMint, quoteProgram);
  let transfers = 0;
  let creates = 0;
  let inits = 0;
  for (const ix of p.tx.instructions) {
    if (isAllowedComputeBudget(ix)) continue;
    const custody = checkCustodyCreate(
      ix,
      master,
      vault.quoteAccount,
      vault.quoteSeed,
      op.assetMint,
      quoteProgram,
    );
    if (custody) {
      v.push(...custody);
      if (ix.programId === SYSTEM_PROGRAM) creates++;
      else inits++;
      continue;
    }
    if (ix.programId === quoteProgram) {
      const d = Buffer.from(ix.dataHex, "hex");
      if (d[0] === SPL_TRANSFER) {
        transfers++;
        const [from, to, owner] = ix.accounts;
        if (from !== source) v.push(`sumber transfer ${from ?? "-"} bukan ATA quote master`);
        if (to !== vault.quoteAccount) v.push(`tujuan transfer ${to ?? "-"} bukan kustodi token`);
        if (owner !== master) v.push("owner transfer harus master wallet");
        if (u64(d, 1) !== op.amountIn)
          v.push(`jumlah transfer ${u64(d, 1)} ≠ operasi ${op.amountIn}`);
        continue;
      }
      v.push(`instruksi SPL Token ${d[0]} tidak diizinkan untuk reserve_fund`);
      continue;
    }
    v.push(`instruksi tidak diizinkan untuk reserve_fund: program ${ix.programId}`);
  }
  if (transfers !== 1) v.push(`harus tepat 1 transfer, ada ${transfers}`);
  if (creates !== inits || creates > 1) v.push("pembuatan akun kustodi harus create + initialize");
  return v;
}

export interface ReserveDeployPolicyInput {
  tx: InspectedTransaction;
  master: string;
  cpmmProgram: string;
  op: PolicyOp;
  plan: ReserveDeployPlanFields;
  /** Pool CPMM hasil migrasi token (diturunkan signer) dan LP mint-nya (graduation worker). */
  cpmmPool: string;
  lpMint: string;
  programs?: ReservePrograms;
}

export function checkReserveDeployPolicy(p: ReserveDeployPolicyInput): string[] {
  const { master, op, plan } = p;
  const v = signerChecks(p.tx, master, [master]);
  if (op.kind !== "reserve_deploy") v.push(`jenis operasi ${op.kind} bukan reserve_deploy`);
  if (!op.tokenMint) return [...v, "reserve_deploy butuh token"];
  const token = op.tokenMint;
  const vault = reserveVaultAddresses(master, token, p.programs);
  // LP mint CPMM selalu SPL Token klasik.
  const lpAta = associatedTokenAddress(master, p.lpMint);
  if (op.target !== token) v.push("target reserve_deploy harus mint token");
  if (!op.amountIn || op.amountIn <= 0n) v.push("batas deployment harus > 0");
  if (plan.swapIn <= 0n || plan.swapMinOut <= 0n) v.push("swap reserve butuh nominal & minOut > 0");
  if (op.minOut !== plan.swapMinOut) v.push("minOut operasi ≠ minOut swap");
  if (plan.lpAmount <= 0n) v.push("LP deployment harus > 0");
  if (plan.swapIn + plan.maxQuote > (op.amountIn ?? 0n))
    v.push("swap + quote deposit melebihi batas deployment operasi");

  let swaps = 0;
  let deposits = 0;
  let burns = 0;
  let closes = 0;
  let creates = 0;
  let inits = 0;
  for (const ix of p.tx.instructions) {
    if (isAllowedComputeBudget(ix)) continue;
    if (ix.programId === ASSOCIATED_TOKEN_PROGRAM_ID) {
      const tag = ix.dataHex === "" ? 0 : Buffer.from(ix.dataHex, "hex")[0];
      const [payer, ata, owner, mint] = ix.accounts;
      if ((tag !== 0 && tag !== 1) || payer !== master || owner !== master)
        v.push("instruksi ATA hanya untuk ATA LP master");
      if (mint !== p.lpMint || ata !== lpAta)
        v.push("ATA selain ATA LP pool token tidak diizinkan");
      continue;
    }
    const custody = checkCustodyCreate(
      ix,
      master,
      vault.tokenAccount,
      vault.tokenSeed,
      token,
      p.programs?.token ?? TOKEN_PROGRAM,
    );
    if (custody) {
      v.push(...custody);
      if (ix.programId === SYSTEM_PROGRAM) creates++;
      else inits++;
      continue;
    }
    if (ix.programId === p.cpmmProgram) {
      const d = Buffer.from(ix.dataHex, "hex");
      if (ix.dataHex.startsWith(CPMM_SWAP_BASE_INPUT)) {
        swaps++;
        const a = CPMM_SWAP_ACCOUNTS;
        const expect: Array<[string, string | undefined, string]> = [
          ["payer", ix.accounts[a.payer], master],
          ["pool", ix.accounts[a.pool], p.cpmmPool],
          ["akun input", ix.accounts[a.userIn], vault.quoteAccount],
          ["akun output", ix.accounts[a.userOut], vault.tokenAccount],
          ["mint input", ix.accounts[a.mintIn], op.assetMint],
          ["mint output", ix.accounts[a.mintOut], token],
        ];
        for (const [name, got, want] of expect) {
          if (got !== want) v.push(`swap reserve ${name} = ${got ?? "-"}, harus ${want}`);
        }
        if (u64(d, 8) !== plan.swapIn) v.push(`swapIn ${u64(d, 8)} ≠ rencana ${plan.swapIn}`);
        if (u64(d, 16) !== plan.swapMinOut) v.push("minOut swap ≠ rencana");
        continue;
      }
      if (ix.dataHex.startsWith(CPMM_DEPOSIT)) {
        deposits++;
        const a = CPMM_DEPOSIT_ACCOUNTS;
        const mint0 = ix.accounts[a.vault0Mint];
        const mint1 = ix.accounts[a.vault1Mint];
        const quoteIs0 = mint0 === op.assetMint;
        if (![mint0, mint1].includes(op.assetMint) || ![mint0, mint1].includes(token))
          v.push("pasangan mint deposit bukan token + quote operasi");
        const expect: Array<[string, string | undefined, string]> = [
          ["owner", ix.accounts[a.owner], master],
          ["pool", ix.accounts[a.pool], p.cpmmPool],
          ["akun LP", ix.accounts[a.ownerLp], lpAta],
          [
            "akun token0",
            ix.accounts[a.token0],
            quoteIs0 ? vault.quoteAccount : vault.tokenAccount,
          ],
          [
            "akun token1",
            ix.accounts[a.token1],
            quoteIs0 ? vault.tokenAccount : vault.quoteAccount,
          ],
          ["LP mint", ix.accounts[a.lpMint], p.lpMint],
        ];
        for (const [name, got, want] of expect) {
          if (got !== want) v.push(`deposit ${name} = ${got ?? "-"}, harus ${want}`);
        }
        const [max0, max1] = quoteIs0
          ? [plan.maxQuote, plan.maxToken]
          : [plan.maxToken, plan.maxQuote];
        if (u64(d, 8) !== plan.lpAmount)
          v.push(`LP deposit ${u64(d, 8)} ≠ rencana ${plan.lpAmount}`);
        if (u64(d, 16) !== max0 || u64(d, 24) !== max1) v.push("batas maksimum deposit ≠ rencana");
        continue;
      }
      v.push("instruksi CPMM selain swap_base_input/deposit tidak diizinkan");
      continue;
    }
    if (ix.programId === TOKEN_PROGRAM) {
      const d = Buffer.from(ix.dataHex, "hex");
      if (d[0] === SPL_BURN) {
        burns++;
        const [account, mint, owner] = ix.accounts;
        if (account !== lpAta || mint !== p.lpMint || owner !== master)
          v.push("burn hanya untuk LP pool token dari ATA LP master");
        if (u64(d, 1) !== plan.lpAmount)
          v.push(`LP dibakar ${u64(d, 1)} ≠ LP deposit ${plan.lpAmount}`);
        continue;
      }
      if (d[0] === SPL_CLOSE_ACCOUNT) {
        closes++;
        const [account, destination, owner] = ix.accounts;
        if (account !== lpAta || destination !== master || owner !== master)
          v.push("close account hanya untuk ATA LP master, rent ke master");
        continue;
      }
      v.push(`instruksi SPL Token ${d[0]} tidak diizinkan untuk reserve_deploy`);
      continue;
    }
    v.push(`instruksi tidak diizinkan untuk reserve_deploy: program ${ix.programId}`);
  }
  if (swaps !== 1) v.push(`harus tepat 1 swap, ada ${swaps}`);
  if (deposits !== 1) v.push(`harus tepat 1 deposit, ada ${deposits}`);
  // Spec §11 Phase 4 / Requirement 6: LP reserve wajib dikunci — di sini dibakar di tx yang sama.
  if (burns !== 1) v.push(`LP harus dibakar di transaksi yang sama (burn ${burns})`);
  if (closes > 1) v.push("lebih dari satu close account");
  if (creates !== inits || creates > 1) v.push("pembuatan akun kustodi harus create + initialize");
  return v;
}

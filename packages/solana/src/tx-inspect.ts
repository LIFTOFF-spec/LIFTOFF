import {
  VersionedTransaction,
  type AddressLookupTableAccount,
  type Connection,
  type PublicKey,
} from "@solana/web3.js";

export interface InspectedInstruction {
  programId: string;
  /** Data instruksi (hex). Untuk program Anchor, 8 byte pertama = discriminator. */
  dataHex: string;
  /** Akun instruksi, sudah di-resolve termasuk yang berasal dari address lookup table. */
  accounts: string[];
  /** Per akun instruksi: writable di transaksi (signer memeriksa akun yang wajib read-only). */
  writable: boolean[];
}

export interface InspectedTransaction {
  feePayer: string;
  requiredSigners: string[];
  recentBlockhash: string;
  instructions: InspectedInstruction[];
  /** Semua akun yang dirujuk (statis + lookup table). */
  accountKeys: string[];
}

export function decodeTransaction(base64: string): VersionedTransaction {
  return VersionedTransaction.deserialize(Buffer.from(base64, "base64"));
}

export function encodeTransaction(tx: VersionedTransaction): string {
  return Buffer.from(tx.serialize()).toString("base64");
}

/** Mengambil address lookup table yang dirujuk transaksi v0. */
export async function fetchLookupTables(
  connection: Connection,
  tx: VersionedTransaction,
): Promise<AddressLookupTableAccount[]> {
  const out: AddressLookupTableAccount[] = [];
  for (const lookup of tx.message.addressTableLookups) {
    const res = await connection.getAddressLookupTable(lookup.accountKey);
    if (!res.value) throw new Error(`lookup table ${lookup.accountKey.toBase58()} tidak ditemukan`);
    out.push(res.value);
  }
  return out;
}

/**
 * Menguraikan transaksi menjadi daftar instruksi dengan akun ter-resolve. Program ID transaksi
 * v0 selalu akun statis (tidak bisa berasal dari lookup table), jadi allowlist program aman.
 */
export function inspectTransaction(
  tx: VersionedTransaction,
  lookupTables: AddressLookupTableAccount[] = [],
): InspectedTransaction {
  const msg = tx.message;
  const keys = msg.getAccountKeys({ addressLookupTableAccounts: lookupTables });
  const all: PublicKey[] = keys.keySegments().flat();
  const at = (i: number) => {
    const k = all[i];
    if (!k) throw new Error(`indeks akun ${i} di luar jangkauan`);
    return k.toBase58();
  };
  const signerCount = msg.header.numRequiredSignatures;
  return {
    feePayer: at(0),
    requiredSigners: msg.staticAccountKeys.slice(0, signerCount).map((k) => k.toBase58()),
    recentBlockhash: msg.recentBlockhash,
    accountKeys: all.map((k) => k.toBase58()),
    instructions: msg.compiledInstructions.map((ix) => {
      if (ix.programIdIndex >= msg.staticAccountKeys.length) {
        throw new Error("program ID dari lookup table tidak diizinkan");
      }
      return {
        programId: at(ix.programIdIndex),
        dataHex: Buffer.from(ix.data).toString("hex"),
        accounts: ix.accountKeyIndexes.map(at),
        writable: ix.accountKeyIndexes.map((i) => msg.isAccountWritable(i)),
      };
    }),
  };
}

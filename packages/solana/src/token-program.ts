/**
 * Program token: SPL Token klasik vs Token-2022.
 *
 * StonkFun hanya mengadopsi launch yang base mint-nya Token-2022 6 desimal (Developer API,
 * docs/BUILD_PLAN.md "StonkFun API"), jadi token BARU LIFTOFF memakai Token-2022. Token lama di
 * devnet (data historis) tetap SPL Token klasik, dan quote mint bisa salah satunya (xStocks =
 * Token-2022). Semua alur (trade, buyback, burn, reserve, signer) memakai helper di sini agar
 * akun token & instruksi selalu memakai program milik mint itu.
 *
 * Modul ini tanpa SDK Raydium (dipakai juga oleh signer & API).
 */
import { PublicKey, SystemProgram, TransactionInstruction, type Connection } from "@solana/web3.js";

export const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
export const ASSOCIATED_TOKEN_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
export const NATIVE_MINT = "So11111111111111111111111111111111111111112";
export const TOKEN_PROGRAMS = [TOKEN_PROGRAM, TOKEN_2022_PROGRAM] as const;

export type TokenProgramKind = "spl" | "token2022";

export function isTokenProgram(program: string | undefined | null): boolean {
  return program === TOKEN_PROGRAM || program === TOKEN_2022_PROGRAM;
}

export function tokenProgramId(kind: TokenProgramKind): string {
  return kind === "token2022" ? TOKEN_2022_PROGRAM : TOKEN_PROGRAM;
}

export function tokenProgramKind(program: string): TokenProgramKind {
  if (program === TOKEN_2022_PROGRAM) return "token2022";
  if (program === TOKEN_PROGRAM) return "spl";
  throw new Error(`bukan program token: ${program}`);
}

export function associatedTokenAddress(owner: string, mint: string, tokenProgram = TOKEN_PROGRAM) {
  return PublicKey.findProgramAddressSync(
    [
      new PublicKey(owner).toBuffer(),
      new PublicKey(tokenProgram).toBuffer(),
      new PublicKey(mint).toBuffer(),
    ],
    new PublicKey(ASSOCIATED_TOKEN_PROGRAM),
  )[0].toBase58();
}

/** ATA milik `owner` untuk `mint` di program token mana pun (dipakai policy signer). */
export function isAssociatedTokenAddressOf(address: string, owner: string, mint: string): boolean {
  return TOKEN_PROGRAMS.some((p) => associatedTokenAddress(owner, mint, p) === address);
}

export function createAtaIdempotentIx(
  payer: string,
  ata: string,
  owner: string,
  mint: string,
  tokenProgram = TOKEN_PROGRAM,
) {
  return new TransactionInstruction({
    programId: new PublicKey(ASSOCIATED_TOKEN_PROGRAM),
    keys: [
      { pubkey: new PublicKey(payer), isSigner: true, isWritable: true },
      { pubkey: new PublicKey(ata), isSigner: false, isWritable: true },
      { pubkey: new PublicKey(owner), isSigner: false, isWritable: false },
      { pubkey: new PublicKey(mint), isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: new PublicKey(tokenProgram), isSigner: false, isWritable: false },
    ],
    data: Buffer.from([1]), // CreateIdempotent
  });
}

export function closeAccountIx(
  account: string,
  destination: string,
  owner: string,
  tokenProgram = TOKEN_PROGRAM,
) {
  return new TransactionInstruction({
    programId: new PublicKey(tokenProgram),
    keys: [
      { pubkey: new PublicKey(account), isSigner: false, isWritable: true },
      { pubkey: new PublicKey(destination), isSigner: false, isWritable: true },
      { pubkey: new PublicKey(owner), isSigner: true, isWritable: false },
    ],
    data: Buffer.from([9]), // CloseAccount
  });
}

/**
 * Ukuran ATA sebuah quote Token-2022 + ekstensi akun yang diwajibkan mint-nya: ImmutableOwner (170),
 * TransferHookAccount (+5), PausableAccount (+4). Dipakai untuk menghitung cukup-tidaknya deposit.
 */
export function quoteAtaSize(info: Pick<MintProgramInfo, "program" | "extensions">): number {
  if (info.program !== TOKEN_2022_PROGRAM) return 165;
  const hook = info.extensions.transferHook || info.extensions.transferHookInactive;
  return 170 + (hook ? 5 : 0) + (info.extensions.pausable ? 4 : 0);
}

/**
 * Ukuran akun token untuk perkiraan rent. ATA Token-2022 selalu membawa ekstensi ImmutableOwner
 * (165 + 1 account type + 4 TLV header = 170 byte); akun SPL klasik 165 byte.
 */
export function tokenAccountSize(tokenProgram: string): number {
  return tokenProgram === TOKEN_2022_PROGRAM ? 170 : 165;
}

/** Ekstensi Token-2022 pada akun mint yang memengaruhi jumlah transfer/akun. */
export interface MintExtensions {
  /** Basis point transfer fee epoch ini (0 = tidak ada / nol). */
  transferFeeBps: number;
  /** Hook aktif: program hook terisi. Ekstensi yang program-nya kosong tidak menjalankan apa pun. */
  transferHook: boolean;
  /** Ekstensi ada tetapi program kosong; penerbit bisa menyalakannya (authority terisi). */
  transferHookInactive: boolean;
  nonTransferable: boolean;
  permanentDelegate: boolean;
  pausable: boolean;
  scaledUiAmount: boolean;
  /** Daftar tipe ekstensi (angka ExtensionType Token-2022). */
  types: number[];
}

/** ExtensionType Token-2022 yang relevan (spl-token-2022 `ExtensionType`). */
const EXT_TRANSFER_FEE_CONFIG = 1;
const EXT_NON_TRANSFERABLE = 9;
const EXT_PERMANENT_DELEGATE = 12;
const EXT_TRANSFER_HOOK = 14;
const EXT_SCALED_UI_AMOUNT = 25;
const EXT_PAUSABLE = 26;

const NO_EXTENSIONS: Omit<MintExtensions, "types"> = {
  transferFeeBps: 0,
  transferHook: false,
  transferHookInactive: false,
  nonTransferable: false,
  permanentDelegate: false,
  pausable: false,
  scaledUiAmount: false,
};

/**
 * Membaca TLV ekstensi dari data akun mint Token-2022 (layout: 82 byte mint dasar, padding
 * sampai 165, 1 byte account type, lalu TLV [u16 type, u16 len, data]). `epoch` dipakai memilih
 * transfer fee older/newer.
 */
export function readMintExtensions(data: Buffer, epoch = Number.MAX_SAFE_INTEGER): MintExtensions {
  const out: MintExtensions = {
    ...NO_EXTENSIONS,
    types: [],
  };
  if (data.length <= 166) return out;
  let o = 166;
  while (o + 4 <= data.length) {
    const type = data.readUInt16LE(o);
    const len = data.readUInt16LE(o + 2);
    const body = data.subarray(o + 4, o + 4 + len);
    if (type === 0 && len === 0) break; // padding
    out.types.push(type);
    if (type === EXT_TRANSFER_FEE_CONFIG && body.length >= 108) {
      // authority(32) + withdraw(32) + withheld(8) + older{epoch u64, max u64, bps u16} + newer{…}
      const newerEpoch = Number(body.readBigUInt64LE(90));
      const olderBps = body.readUInt16LE(88);
      const newerBps = body.readUInt16LE(106);
      out.transferFeeBps = epoch >= newerEpoch ? newerBps : olderBps;
    }
    if (type === EXT_TRANSFER_HOOK) {
      // authority(32) + program(32). Body tidak utuh = dianggap aktif (gagal tertutup).
      const active = body.length < 64 || body.subarray(32, 64).some((b) => b !== 0);
      out.transferHook = active;
      out.transferHookInactive = !active;
    }
    if (type === EXT_NON_TRANSFERABLE) out.nonTransferable = true;
    if (type === EXT_PERMANENT_DELEGATE) out.permanentDelegate = true;
    if (type === EXT_SCALED_UI_AMOUNT) out.scaledUiAmount = true;
    if (type === EXT_PAUSABLE) out.pausable = true;
    o += 4 + len;
  }
  return out;
}

export interface MintProgramInfo {
  program: string;
  decimals: number;
  supply: bigint;
  /** Authority pembeku akun token; terisi = penerbit bisa membekukan saldo. */
  freezeAuthority: boolean;
  extensions: MintExtensions;
}

/** Info mint dari data akun (program pemilik + desimal + supply + ekstensi). null = bukan mint. */
export function parseMintAccount(owner: string, data: Buffer): MintProgramInfo | null {
  if (!isTokenProgram(owner) || data.length < 82) return null;
  return {
    program: owner,
    decimals: data[44]!,
    supply: data.readBigUInt64LE(36),
    freezeAuthority: data.readUInt32LE(46) === 1,
    extensions:
      owner === TOKEN_2022_PROGRAM ? readMintExtensions(data) : { ...NO_EXTENSIONS, types: [] },
  };
}

/**
 * Alasan quote mint Token-2022 tidak bisa dipakai LIFTOFF (null = boleh). Transfer fee mengubah
 * jumlah yang diterima pool/penerima (matematika quote, rekonsiliasi & batas policy signer
 * menganggap jumlah persis), transfer hook butuh akun tambahan: keduanya gagal aman.
 */
export function unsupportedQuoteReason(info: MintProgramInfo): string | null {
  if (info.extensions.transferHook) return "Quote mints with a transfer hook are not supported.";
  if (info.extensions.nonTransferable) return "The quote mint is non-transferable.";
  if (info.extensions.transferFeeBps > 0) {
    return "Quote mints with a transfer fee are not supported by LIFTOFF yet.";
  }
  return null;
}

/** Risiko quote yang tetap boleh dipakai, untuk label sebelum konfirmasi (keputusan pemilik 3A). */
export function quoteWarnings(info: MintProgramInfo): string[] {
  const e = info.extensions;
  const out: string[] = [];
  if (e.permanentDelegate) {
    out.push("The issuer of this token can move or burn balances, including the pool and reserve.");
  }
  if (e.pausable || info.freezeAuthority) {
    out.push("The issuer of this token can freeze or pause transfers, which would stop trading.");
  }
  if (e.transferHookInactive) {
    out.push(
      "The issuer can turn on a transfer hook later. LIFTOFF would then stop trades in this pair.",
    );
  }
  if (e.scaledUiAmount) {
    out.push(
      "Wallets may show this token multiplied by an issuer factor, so amounts can look slightly different.",
    );
  }
  return out;
}

// Program pemilik mint tidak bisa berubah → cache per proses aman.
const programCache = new Map<string, string>();

/** Program token pemilik mint (cache permanen). WSOL selalu SPL Token klasik. */
export async function mintProgramOf(connection: Connection, mint: string): Promise<string> {
  if (mint === NATIVE_MINT) return TOKEN_PROGRAM;
  const cached = programCache.get(mint);
  if (cached) return cached;
  const info = await connection.getAccountInfo(new PublicKey(mint), "confirmed");
  if (!info) throw new Error(`mint ${mint} tidak ditemukan`);
  const owner = info.owner.toBase58();
  if (!isTokenProgram(owner)) throw new Error(`akun ${mint} bukan mint SPL Token/Token-2022`);
  programCache.set(mint, owner);
  return owner;
}

/** Mengisi cache program dari sumber tepercaya (mis. state pool LaunchLab yang sudah dibaca). */
export function rememberMintProgram(mint: string, program: string) {
  if (isTokenProgram(program)) programCache.set(mint, program);
}

/** SPL Token / Token-2022 `Burn` (tag 8): data [8, u64 amount]. */
export function burnIx(
  account: string,
  mint: string,
  owner: string,
  amount: bigint,
  tokenProgram = TOKEN_PROGRAM,
) {
  const data = Buffer.alloc(9);
  data[0] = 8;
  data.writeBigUInt64LE(amount, 1);
  return new TransactionInstruction({
    programId: new PublicKey(tokenProgram),
    keys: [
      { pubkey: new PublicKey(account), isSigner: false, isWritable: true },
      { pubkey: new PublicKey(mint), isSigner: false, isWritable: true },
      { pubkey: new PublicKey(owner), isSigner: true, isWritable: false },
    ],
    data,
  });
}

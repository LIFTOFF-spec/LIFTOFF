/**
 * Sign-In With Solana (SIWS) — identitas utama pengguna (D9).
 *
 * Pengguna menandatangani PESAN teks dengan wallet-nya (signMessage). Tidak ada transaksi dan
 * tidak ada biaya. Server membuat pesan beserta nonce sekali pakai, menyimpannya, lalu
 * memverifikasi tanda tangan ed25519 atas pesan yang persis sama.
 */

const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const BASE58_MAP = new Map([...BASE58_ALPHABET].map((c, i) => [c, BigInt(i)]));

export function base58Encode(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let out = "";
  while (n > 0n) {
    out = BASE58_ALPHABET[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = `1${out}`;
  }
  return out;
}

/** Melempar jika input bukan base58 yang valid. */
export function base58Decode(text: string): Uint8Array {
  let n = 0n;
  for (const c of text) {
    const v = BASE58_MAP.get(c);
    if (v === undefined) throw new Error("base58 tidak valid");
    n = n * 58n + v;
  }
  const bytes: number[] = [];
  while (n > 0n) {
    bytes.unshift(Number(n & 0xffn));
    n >>= 8n;
  }
  for (const c of text) {
    if (c !== "1") break;
    bytes.unshift(0);
  }
  return Uint8Array.from(bytes);
}

/** Alamat wallet Solana = public key ed25519 32 byte dalam base58. */
export function isSolanaAddress(value: string): boolean {
  try {
    return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value) && base58Decode(value).length === 32;
  } catch {
    return false;
  }
}

export interface SiwsMessageParams {
  /** Host web, mis. "localhost:3000". */
  domain: string;
  wallet: string;
  uri: string;
  cluster: string;
  nonce: string;
  issuedAt: string;
  expirationTime: string;
}

/** Spec SIWS hanya mengenal "mainnet", bukan nama cluster RPC "mainnet-beta". */
function siwsChainId(cluster: string): string {
  return cluster === "mainnet-beta" ? "mainnet" : cluster;
}

/** Format mengikuti gaya EIP-4361 / SIWS agar mudah dibaca di popup wallet. */
export function buildSiwsMessage(p: SiwsMessageParams): string {
  return [
    `${p.domain} wants you to sign in with your Solana account:`,
    p.wallet,
    "",
    "Sign in to LIFTOFF. This only proves you own this wallet: it does not send a transaction and costs nothing.",
    "",
    `URI: ${p.uri}`,
    "Version: 1",
    `Chain ID: ${siwsChainId(p.cluster)}`,
    `Nonce: ${p.nonce}`,
    `Issued At: ${p.issuedAt}`,
    `Expiration Time: ${p.expirationTime}`,
  ].join("\n");
}

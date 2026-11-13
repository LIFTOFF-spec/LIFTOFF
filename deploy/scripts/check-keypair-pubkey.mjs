// Mencetak ALAMAT PUBLIK dari file keypair Solana, tanpa pernah menampilkan isi kuncinya.
// Dipakai untuk mengecek salinan cadangan kunci master (docs/DEPLOY.md §4a). Tanpa dependensi dan
// tanpa akses jaringan: cukup Node.js.
//   node check-keypair-pubkey.mjs <file-keypair> [alamat-yang-diharapkan]
// Kode keluar: 0 = file sah (dan cocok bila alamat diberikan), 1 = rusak / tidak cocok.
import { createPrivateKey, createPublicKey } from "node:crypto";
import { readFileSync } from "node:fs";

const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function base58(bytes) {
  let n = 0n;
  for (const b of bytes) n = n * 256n + BigInt(b);
  let out = "";
  while (n > 0n) {
    out = BASE58[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = `1${out}`;
  }
  return out;
}

/** Alamat dari 32 byte pertama (seed), bukan sekadar menyalin bagian publik di file. */
function addressFromSeed(seed) {
  const pkcs8Prefix = Buffer.from("302e020100300506032b657004220420", "hex");
  const key = createPrivateKey({
    key: Buffer.concat([pkcs8Prefix, seed]),
    format: "der",
    type: "pkcs8",
  });
  const der = createPublicKey(key).export({ format: "der", type: "spki" });
  return Buffer.from(der.subarray(der.length - 32));
}

function fail(message) {
  console.error(`GAGAL: ${message}`);
  process.exit(1);
}

const [path, expected] = process.argv.slice(2);
if (!path) fail("pakai: node check-keypair-pubkey.mjs <file-keypair> [alamat-yang-diharapkan]");

let raw;
try {
  raw = JSON.parse(readFileSync(path, "utf8"));
} catch (err) {
  // Isi file tidak pernah ikut ke pesan.
  fail(`file tidak bisa dibaca (${err.name})`);
}
if (
  !Array.isArray(raw) ||
  raw.length !== 64 ||
  !raw.every((b) => Number.isInteger(b) && b >= 0 && b < 256)
) {
  fail("bukan file keypair Solana (harus daftar 64 angka)");
}
const bytes = Buffer.from(raw);
const address = addressFromSeed(bytes.subarray(0, 32));
if (!address.equals(bytes.subarray(32))) {
  fail("file rusak: bagian rahasia dan bagian publik tidak cocok");
}
const text = base58(address);
console.log(`Alamat publik: ${text}`);
if (expected && expected !== text) fail(`TIDAK COCOK dengan alamat yang diharapkan ${expected}`);
if (expected) console.log("COCOK dengan alamat yang diharapkan.");

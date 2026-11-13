/**
 * Key material. Hanya modul ini yang membaca file keypair; secret tidak pernah dicetak,
 * di-log, atau dikirim lewat respons.
 */
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { Keypair } from "@solana/web3.js";

export function loadMasterKeypair(path: string): Keypair {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    // Jangan menyertakan isi file di pesan error.
    throw new Error(
      `keypair master tidak bisa dibaca dari SIGNER_KEYPAIR_PATH (${(err as Error).name})`,
    );
  }
  if (!Array.isArray(raw) || raw.length !== 64 || !raw.every((b) => Number.isInteger(b))) {
    throw new Error("format keypair master tidak valid (harus array 64 byte)");
  }
  return Keypair.fromSecretKey(Uint8Array.from(raw as number[]));
}

const MINT_DOMAIN = "liftoff/launch-mint/v1/";

/**
 * Mint keypair launch diturunkan deterministik dari secret master + jobId (HMAC-SHA256 → seed
 * ed25519). Akibatnya:
 *  - setiap pengiriman ulang job yang sama memakai mint yang SAMA (tidak bisa launch ganda:
 *    akun mint yang sudah ada membuat transaksi create kedua gagal on-chain);
 *  - secret mint tidak perlu disimpan di mana pun dan tidak pernah keluar dari signer;
 *  - pubkey mint hanya diberikan ke worker (internal) dan tidak dipublikasikan sebelum live (P5).
 * Setelah launch, mint keypair tidak punya otoritas apa pun (mint authority dipegang LaunchLab).
 */
export function deriveMintKeypair(master: Keypair, jobId: string): Keypair {
  const seed = createHmac("sha256", Buffer.from(master.secretKey))
    .update(MINT_DOMAIN + jobId)
    .digest();
  return Keypair.fromSeed(seed);
}

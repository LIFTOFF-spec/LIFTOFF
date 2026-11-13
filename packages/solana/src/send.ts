/**
 * Jalur pengiriman transaksi yang dipilih lewat config (LAUNCH_SEND_MODE):
 *  - `rpc`  — sendRawTransaction biasa. Satu-satunya jalur di devnet; BUKAN private bundle.
 *  - `jito` — bundle Jito + tip. Jito tidak ada di devnet (Tahap 1), jadi jalur ini baru diuji
 *    di mainnet pada Tahap 10. Di devnet konfigurasi `jito` ditolak saat start.
 */
import type { Connection } from "@solana/web3.js";
import { base58Encode, type LaunchSendMode, type SolanaCluster } from "@liftoff/shared";
import { decodeTransaction } from "./tx-inspect";

export interface SendResult {
  signature: string;
  bundleId: string | null;
}

export interface TxSender {
  readonly mode: LaunchSendMode;
  /** Akun tip yang harus dibayar transaksi (hanya Jito). */
  tipAccount(): Promise<string | null>;
  send(signedBase64: string): Promise<SendResult>;
}

/** Signature = tanda tangan pertama (fee payer), sudah diketahui sebelum dikirim. */
export function signatureOf(signedBase64: string): string {
  const sig = decodeTransaction(signedBase64).signatures[0];
  if (!sig || sig.every((b) => b === 0)) throw new Error("transaksi belum ditandatangani");
  return base58Encode(sig);
}

export class RpcSender implements TxSender {
  readonly mode = "rpc" as const;
  constructor(private readonly connection: Connection) {}

  async tipAccount() {
    return null;
  }

  async send(signedBase64: string): Promise<SendResult> {
    const signature = signatureOf(signedBase64);
    // Signer sudah menyimulasikan; preflight dilewati agar pengiriman tidak gagal karena
    // simulasi kedua di node RPC yang tertinggal slot.
    await this.connection.sendRawTransaction(Buffer.from(signedBase64, "base64"), {
      skipPreflight: true,
      maxRetries: 5,
    });
    return { signature, bundleId: null };
  }
}

export class JitoSender implements TxSender {
  readonly mode = "jito" as const;
  constructor(
    private readonly blockEngineUrl: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async rpc<T>(path: string, method: string, params: unknown[]): Promise<T> {
    const res = await this.fetchImpl(new URL(path, this.blockEngineUrl), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: AbortSignal.timeout(10_000),
    });
    const body = (await res.json()) as { result?: T; error?: { message?: string } };
    if (!res.ok || body.error || body.result === undefined) {
      throw new Error(`Jito ${method} gagal: ${body.error?.message ?? res.status}`);
    }
    return body.result;
  }

  async tipAccount(): Promise<string> {
    const accounts = await this.rpc<string[]>("/api/v1/bundles", "getTipAccounts", []);
    const pick = accounts[Math.floor(Math.random() * accounts.length)];
    if (!pick) throw new Error("Jito tidak mengembalikan akun tip");
    return pick;
  }

  async send(signedBase64: string): Promise<SendResult> {
    const signature = signatureOf(signedBase64);
    const bundleId = await this.rpc<string>("/api/v1/bundles", "sendBundle", [
      [signedBase64],
      { encoding: "base64" },
    ]);
    return { signature, bundleId };
  }
}

export function assertSendModeAllowed(mode: LaunchSendMode, cluster: SolanaCluster): void {
  if (mode === "jito" && cluster !== "mainnet-beta") {
    throw new Error(
      `LAUNCH_SEND_MODE=jito tidak tersedia di ${cluster} (Jito tidak ada di devnet); pakai rpc`,
    );
  }
}

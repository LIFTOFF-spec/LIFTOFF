/**
 * Deposit launch = biaya launch dibayar creator (LAUNCH_DEPOSIT_ENABLED, default aktif; 0 = gratis).
 * Pengguna mentransfer deposit ke master wallet lalu mengirim signature-nya bersama request
 * launch. API memverifikasi transfer on-chain; worker mengembalikannya jika launch gagal permanen.
 */
import { Connection, PublicKey, type ParsedInstruction } from "@solana/web3.js";

export type DepositCheck = { ok: true; lamports: bigint } | { ok: false; reason: string };

export interface DepositVerifier {
  verify(p: {
    signature: string;
    payer: string;
    recipient: string;
    minLamports: bigint;
  }): Promise<DepositCheck>;
}

/** Deposit lebih tua dari ini ditolak (signature lama tidak bisa dipakai ulang untuk launch baru). */
const MAX_DEPOSIT_AGE_SECONDS = 24 * 60 * 60;

export class RpcDepositVerifier implements DepositVerifier {
  private readonly connection: Connection;
  constructor(rpcUrl: string) {
    this.connection = new Connection(rpcUrl, "confirmed");
  }

  async verify(p: { signature: string; payer: string; recipient: string; minLamports: bigint }) {
    let tx;
    try {
      tx = await this.connection.getParsedTransaction(p.signature, {
        commitment: "confirmed",
        maxSupportedTransactionVersion: 0,
      });
    } catch {
      return {
        ok: false as const,
        reason: "Could not check the deposit transaction right now. Try again.",
      };
    }
    if (!tx)
      return {
        ok: false as const,
        reason: "Deposit transaction not found (or not confirmed yet).",
      };
    if (tx.meta?.err) return { ok: false as const, reason: "Deposit transaction failed on-chain." };
    if (tx.blockTime && Date.now() / 1000 - tx.blockTime > MAX_DEPOSIT_AGE_SECONDS) {
      return { ok: false as const, reason: "Deposit transaction is too old. Send a new deposit." };
    }
    let total = 0n;
    for (const ix of tx.transaction.message.instructions) {
      const parsed = (ix as ParsedInstruction).parsed as
        | { type?: string; info?: { source?: string; destination?: string; lamports?: number } }
        | undefined;
      if (
        (ix as ParsedInstruction).program === "system" &&
        parsed?.type === "transfer" &&
        parsed.info?.source === p.payer &&
        parsed.info.destination === p.recipient
      ) {
        total += BigInt(parsed.info.lamports ?? 0);
      }
    }
    if (total < p.minLamports) {
      return {
        ok: false as const,
        reason: `Deposit must be a transfer of at least ${p.minLamports} lamports from your wallet to ${new PublicKey(p.recipient).toBase58()}.`,
      };
    }
    return { ok: true as const, lamports: total };
  }
}

/** Untuk test. */
export class StaticDepositVerifier implements DepositVerifier {
  constructor(
    private readonly result: (signature: string) => DepositCheck = () => ({
      ok: true,
      lamports: 100_000_000n,
    }),
  ) {}
  async verify(p: { signature: string }) {
    return this.result(p.signature);
  }
}

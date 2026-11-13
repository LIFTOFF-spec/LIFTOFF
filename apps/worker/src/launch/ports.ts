/** Port yang dipakai launch engine (implementasi nyata di rpc-chain.ts / signer-client.ts, palsu di test). */
import type {
  PairConfig,
  SignPurpose,
  SignerErrorCode,
  StonkFunLaunchPricing,
} from "@liftoff/shared";
import type { SendResult } from "@liftoff/solana";

export interface BuiltTx {
  /** Transaksi belum ditandatangani (base64). */
  transaction: string;
  lastValidBlockHeight: number;
}

export type Verification =
  { ok: true; pool: string } | { ok: false; exists: boolean; reason: string };

export interface SignatureStatus {
  slot: number;
  err: unknown;
  confirmationStatus: "processed" | "confirmed" | "finalized" | null;
}

export interface LaunchChain {
  buildLaunch(p: {
    mint: string;
    name: string;
    symbol: string;
    uri: string;
    pair: PairConfig;
    /** Parameter create dari StonkFunAdapter.launchPricing (raise, configId, curve-rule, program). */
    pricing: StonkFunLaunchPricing;
    tipAccount: string | null;
  }): Promise<BuiltTx>;
  buildTransfer(p: { to: string; lamports: bigint }): Promise<BuiltTx>;
  verifyLaunch(p: { mint: string; pair: PairConfig }): Promise<Verification>;
  signatureStatuses(signatures: string[]): Promise<Array<SignatureStatus | null>>;
  blockHeight(): Promise<number>;
}

export interface Sender {
  readonly mode: "rpc" | "jito";
  tipAccount(): Promise<string | null>;
  send(signedBase64: string): Promise<SendResult>;
}

export class SignerClientError extends Error {
  constructor(
    readonly code: SignerErrorCode | "network",
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "SignerClientError";
  }
}

export interface SignerClient {
  deriveMint(jobId: string): Promise<{ mint: string }>;
  sign(p: { purpose: SignPurpose; jobId?: string; opId?: string; transaction: string }): Promise<{
    signature: string;
    transaction: string;
  }>;
}

import type { PairConfig, PlatformAddresses, StonkFunLaunchPricing } from "@liftoff/shared";
import { encodeTransaction } from "@liftoff/solana";
import { buildLaunchTransaction, verifyLaunchOnChain } from "@liftoff/solana/launchlab";
import {
  PublicKey,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
  type Connection,
} from "@solana/web3.js";
import type { BuiltTx, LaunchChain, SignatureStatus, Verification } from "./ports";

export class RpcLaunchChain implements LaunchChain {
  constructor(
    private readonly connection: Connection,
    private readonly platform: PlatformAddresses,
    private readonly tipLamports: number,
    private readonly fundRaisingOverride: bigint | null = null,
  ) {}

  async buildLaunch(p: {
    mint: string;
    name: string;
    symbol: string;
    uri: string;
    pair: PairConfig;
    pricing: StonkFunLaunchPricing;
    tipAccount: string | null;
  }): Promise<BuiltTx> {
    const built = await buildLaunchTransaction({
      connection: this.connection,
      platform: this.platform,
      mint: p.mint,
      name: p.name,
      symbol: p.symbol,
      uri: p.uri,
      pair: p.pair,
      pricing: p.pricing,
      ...(this.fundRaisingOverride ? { totalFundRaisingOverride: this.fundRaisingOverride } : {}),
      ...(p.tipAccount ? { tip: { account: p.tipAccount, lamports: this.tipLamports } } : {}),
    });
    return {
      transaction: encodeTransaction(built.transaction),
      lastValidBlockHeight: built.lastValidBlockHeight,
    };
  }

  async buildTransfer(p: { to: string; lamports: bigint }): Promise<BuiltTx> {
    const master = new PublicKey(this.platform.masterWallet);
    const latest = await this.connection.getLatestBlockhash("confirmed");
    const message = new TransactionMessage({
      payerKey: master,
      recentBlockhash: latest.blockhash,
      instructions: [
        SystemProgram.transfer({
          fromPubkey: master,
          toPubkey: new PublicKey(p.to),
          lamports: p.lamports,
        }),
      ],
    }).compileToV0Message();
    return {
      transaction: encodeTransaction(new VersionedTransaction(message)),
      lastValidBlockHeight: latest.lastValidBlockHeight,
    };
  }

  verifyLaunch(p: { mint: string; pair: PairConfig }): Promise<Verification> {
    return verifyLaunchOnChain(this.connection, { platform: this.platform, ...p });
  }

  async signatureStatuses(signatures: string[]): Promise<Array<SignatureStatus | null>> {
    const res = await this.connection.getSignatureStatuses(signatures, {
      searchTransactionHistory: true,
    });
    return res.value.map((s) =>
      s ? { slot: s.slot, err: s.err, confirmationStatus: s.confirmationStatus ?? null } : null,
    );
  }

  blockHeight(): Promise<number> {
    return this.connection.getBlockHeight("confirmed");
  }
}

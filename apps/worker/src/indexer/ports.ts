import type {
  CpmmPoolSnapshot,
  LaunchPoolSnapshot,
  SignatureInfo,
  TokenAccountBalance,
} from "@liftoff/solana/market";
import type { ParsedTradeTransaction, TradePrograms } from "@liftoff/solana/trade";

/** Akses chain yang dibutuhkan indexer (diimplementasikan `MarketReader`; dipalsukan di test). */
export interface IndexerChain {
  readonly programs: TradePrograms;
  launchPoolAddress(mint: string, quoteMint: string): string;
  migrationConfigId(): Promise<string>;
  cpmmPoolAddress(mint: string, quoteMint: string): Promise<string>;
  readLaunchPool(address: string): Promise<LaunchPoolSnapshot | null>;
  readCpmmPool(address: string): Promise<CpmmPoolSnapshot | null>;
  mintSupplies(mints: string[]): Promise<Map<string, bigint | null>>;
  tokenAccounts(mint: string): Promise<TokenAccountBalance[]>;
  signatures(
    address: string,
    opts: { until?: string; before?: string; limit: number },
  ): Promise<SignatureInfo[]>;
  /** null = transaksi belum tersedia di RPC. Melempar `UnsupportedTransactionError` bila tak terurai. */
  transaction(signature: string): Promise<ParsedTradeTransaction | null>;
}

export interface IndexerLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
}

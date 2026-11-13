import type {
  CpmmPoolSnapshot,
  LaunchPoolSnapshot,
  SignatureInfo,
  TokenAccountBalance,
} from "@liftoff/solana/market";
import { UnsupportedTransactionError } from "@liftoff/solana/market";
import type {
  CpmmSwapEvent,
  LaunchlabTradeEvent,
  ParsedTradeTransaction,
} from "@liftoff/solana/trade";
import type { IndexerChain } from "./ports";

export const PROGRAMS = {
  launchlab: "DRay6fNdQ5J82H7xV6uq2aV3mNrUZ1J4PgSKsWgptcm6",
  cpmm: "DRaycpLY18LhpbydsBWbVJtxpNv9oXPgjRSfpF2bWpYb",
};
export const CP_CONFIG = "5MxLgy9oPdTC3YgkiePHqr3EoCRD9uLVYRQS2ANAs7wy";

type TxEntry = ParsedTradeTransaction | null | "unsupported" | Error;

/** Chain palsu dengan semantik getSignaturesForAddress (terbaru dulu, until/before eksklusif). */
export class FakeIndexerChain implements IndexerChain {
  readonly programs = PROGRAMS;
  launchPools = new Map<string, LaunchPoolSnapshot>();
  cpmmPools = new Map<string, CpmmPoolSnapshot>();
  /** Per alamat, urutan kronologis (lama → baru). */
  history = new Map<string, SignatureInfo[]>();
  txs = new Map<string, TxEntry>();
  supplies = new Map<string, bigint>();
  accounts = new Map<string, TokenAccountBalance[]>();
  calls = 0;

  launchPoolAddress(mint: string) {
    return `curve-${mint}`;
  }
  async migrationConfigId() {
    return CP_CONFIG;
  }
  async cpmmPoolAddress(mint: string) {
    return `cpmm-${mint}`;
  }
  async readLaunchPool(address: string) {
    this.calls++;
    return this.launchPools.get(address) ?? null;
  }
  async readCpmmPool(address: string) {
    this.calls++;
    return this.cpmmPools.get(address) ?? null;
  }
  async mintSupplies(mints: string[]) {
    return new Map(mints.map((m) => [m, this.supplies.get(m) ?? null]));
  }
  async tokenAccounts(mint: string) {
    return this.accounts.get(mint) ?? [];
  }
  async signatures(address: string, opts: { until?: string; before?: string; limit: number }) {
    this.calls++;
    const newestFirst = [...(this.history.get(address) ?? [])].reverse();
    let start = 0;
    if (opts.before) start = newestFirst.findIndex((s) => s.signature === opts.before) + 1;
    let end = newestFirst.length;
    if (opts.until) {
      const i = newestFirst.findIndex((s) => s.signature === opts.until);
      if (i >= 0) end = i;
    }
    return newestFirst.slice(start, end).slice(0, opts.limit);
  }
  async transaction(signature: string) {
    this.calls++;
    const t = this.txs.get(signature);
    if (t === "unsupported") throw new UnsupportedTransactionError(signature, "version 1");
    if (t instanceof Error) throw t;
    return t ?? null;
  }

  /** Menambah transaksi ke riwayat alamat-alamat yang dirujuknya. */
  push(addresses: string[], tx: ParsedTradeTransaction | "unsupported" | null, sig?: string) {
    const signature = sig ?? (tx && tx !== "unsupported" ? tx.signature : `sig-${Math.random()}`);
    for (const a of addresses) {
      const list = this.history.get(a) ?? [];
      list.push({ signature, slot: list.length + 1, failed: false, blockTime: 1_793_000_000 });
      this.history.set(a, list);
    }
    this.txs.set(signature, tx);
    return signature;
  }
}

let seq = 0;
export function uniqueSig(prefix = "sig") {
  seq++;
  return `${prefix}-${Date.now().toString(36)}-${seq}-${Math.random().toString(36).slice(2, 10)}`;
}

export function curveEvent(pool: string, over: Partial<LaunchlabTradeEvent> = {}) {
  return {
    pool,
    amountIn: 4_000_000n,
    amountOut: 150_000_000_000n,
    protocolFee: 10_000n,
    platformFee: 40_000n,
    creatorFee: 20_000n,
    shareFee: 0n,
    direction: 0,
    poolStatus: 0,
    virtualBase: 1_073_025_609_049_470n,
    virtualQuote: 30_000_000n,
    realBaseAfter: 150_000_000_000n,
    realQuoteAfter: 3_930_000n,
    ...over,
  } satisfies LaunchlabTradeEvent;
}

export function swapEvent(pool: string, quoteMint: string, mint: string) {
  return {
    pool,
    inputVaultBefore: 100_000_000n,
    outputVaultBefore: 200_000_000_000_000n,
    inputAmount: 5_000_000n,
    outputAmount: 9_000_000_000_000n,
    inputMint: quoteMint,
    outputMint: mint,
    tradeFee: 12_500n,
    creatorFee: 12_500n,
    creatorFeeOnInput: true,
  } satisfies CpmmSwapEvent;
}

export function parsedTx(
  signature: string,
  opts: {
    launchlab?: LaunchlabTradeEvent[];
    cpmm?: CpmmSwapEvent[];
    accountKeys?: string[];
    failed?: boolean;
  } = {},
): ParsedTradeTransaction {
  const launchlabEvents = opts.launchlab ?? [];
  const cpmmEvents = opts.cpmm ?? [];
  return {
    signature,
    slot: 1,
    blockTime: 1_793_000_000,
    wallet: "OutsideTrader1111111111111111111111111111111",
    failed: opts.failed ?? false,
    launchlab: launchlabEvents[0] ?? null,
    cpmm: cpmmEvents[0] ?? null,
    launchlabEvents,
    cpmmEvents,
    tokenDeltas: [],
    accountKeys: opts.accountKeys ?? [],
  };
}

export function launchPool(
  address: string,
  mint: string,
  quoteMint: string,
  creator: string,
  over: Partial<LaunchPoolSnapshot> = {},
): LaunchPoolSnapshot {
  return {
    address,
    status: 0,
    migrateType: 1,
    mintDecimalsA: 6,
    mintDecimalsB: 9,
    supply: 1_000_000_000_000_000n,
    totalSellA: 793_100_000_000_000n,
    virtualA: 1_073_025_609_049_470n,
    virtualB: 30_000_000n,
    realA: 150_000_000_000n,
    realB: 3_930_000n,
    totalFundRaisingB: 100_000_000n,
    configId: "7ZR4zD7PYfY2XxoG1Gxcy2EgEeGYrpxrwzPuwdUBssEt",
    platformId: "21vCqsaZhkK8NY1DmPQJuD3bLxjGCeLHbLZrbHpjxozE",
    mintA: mint,
    mintB: quoteMint,
    creator,
    ...over,
  };
}

export function cpmmPool(
  address: string,
  mint: string,
  quoteMint: string,
  creator: string,
  over: Partial<CpmmPoolSnapshot> = {},
): CpmmPoolSnapshot {
  return {
    address,
    configId: CP_CONFIG,
    poolCreator: creator,
    mintA: quoteMint,
    mintB: mint,
    mintLp: `lp-${mint}`,
    mintProgramA: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
    mintProgramB: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
    status: 0,
    lpAmount: 143_840_189_098n,
    openTime: 1_793_193_442n,
    enableCreatorFee: true,
    reserveA: 95_000_000n,
    reserveB: 200_000_000_000_000n,
    ...over,
  };
}

import { pairForMint, type PlatformAddresses, type SolanaCluster } from "@liftoff/shared";
import { fetchLookupTables } from "@liftoff/solana";
import { poolMetrics } from "@liftoff/solana/reserve";
import { mintProgramOf } from "@liftoff/solana/token-program";
import { globalConfigQuoteMint, readPlatformConfig } from "@liftoff/solana/launchlab";
import { loadMarket, quoteFromMarket, TradeError, type TradeEnv } from "@liftoff/solana/trade";
import { PublicKey, type Connection, type VersionedTransaction } from "@solana/web3.js";
import { SignerError, type PoolQuote, type SignerChain, type SimulationResult } from "./service";

/** Saldo akun token (SPL & Token-2022: u64 di offset 64). Akun tidak ada / tertutup = 0. */
export function tokenAmountOf(data: Buffer | null | undefined): bigint {
  return data && data.length >= 72 ? data.readBigUInt64LE(64) : 0n;
}

export class RpcSignerChain implements SignerChain {
  private readonly tradeEnv: TradeEnv;

  constructor(
    private readonly connection: Connection,
    private readonly platform: PlatformAddresses,
    private readonly cluster: SolanaCluster = "devnet",
    /** F8: chain yang sama di RPC cadangan (cek silang). */
    readonly backup: SignerChain | null = null,
  ) {
    // Signer hanya menandatangani buyback/deploy di curve LaunchLab & pool CPMM (jalur Jupiter
    // mainnet belum diimplementasikan worker); referral tidak pernah dipakai buyback.
    this.tradeEnv = { connection, platform, referralWallet: null, graduatedRoute: "cpmm" };
  }

  async platformCpConfigId(): Promise<string> {
    return (await readPlatformConfig(this.connection, this.platform)).cpConfigId.toBase58();
  }

  launchConfigQuoteMint(configId: string): Promise<string | null> {
    return globalConfigQuoteMint(this.connection, this.platform, configId);
  }

  async signatureLanded(signature: string): Promise<boolean> {
    const res = await this.connection.getSignatureStatuses([signature], {
      searchTransactionHistory: true,
    });
    return res.value[0] != null;
  }

  async blockhashValid(blockhash: string): Promise<boolean> {
    // "processed": paling longgar — blockhash dianggap hidup selama node mana pun masih menerimanya.
    return (await this.connection.isBlockhashValid(blockhash, { commitment: "processed" })).value;
  }

  mintProgram(mint: string): Promise<string> {
    return mintProgramOf(this.connection, mint);
  }

  lookupTables(tx: VersionedTransaction) {
    return fetchLookupTables(this.connection, tx);
  }

  async balance(address: string): Promise<bigint> {
    return BigInt(await this.connection.getBalance(new PublicKey(address), "confirmed"));
  }

  async tokenBalances(accounts: string[]): Promise<bigint[]> {
    if (!accounts.length) return [];
    const infos = await this.connection.getMultipleAccountsInfo(
      accounts.map((a) => new PublicKey(a)),
      "confirmed",
    );
    return infos.map((i) => tokenAmountOf(i?.data));
  }

  async quoteBuy(p: { mint: string; quoteMint: string; amountIn: bigint }): Promise<PoolQuote> {
    const pair = pairForMint(this.cluster, p.quoteMint);
    if (!pair) throw new SignerError("policy_violation", "quote mint bukan pair LIFTOFF", false);
    const target = { mint: p.mint, pair };
    try {
      const market = await loadMarket(this.tradeEnv, target);
      if (market.route === "jupiter") {
        throw new SignerError("policy_violation", "rute jupiter tidak didukung signer", false);
      }
      const q = quoteFromMarket(this.tradeEnv, target, market, {
        side: "buy",
        amountIn: p.amountIn,
        slippageBps: 0,
      });
      const m = market.route === "cpmm" ? poolMetrics(market, p.mint) : null;
      return {
        route: market.route,
        pool: market.poolId,
        amountIn: BigInt(q.amountIn),
        expectedOut: BigInt(q.expectedOut),
        cpmm: m
          ? { reserveToken: m.reserveToken, reserveQuote: m.reserveQuote, lpSupply: m.lpSupply }
          : null,
      };
    } catch (err) {
      if (err instanceof TradeError) {
        // Pool sedang migrasi / belum ada: bukan pelanggaran permanen, coba lagi nanti.
        throw new SignerError("policy_violation", `state pool: ${err.code}`, true);
      }
      throw err;
    }
  }

  async fee(tx: VersionedTransaction): Promise<bigint> {
    const res = await this.connection.getFeeForMessage(tx.message, "confirmed");
    // null = blockhash tidak dikenal node; simulasi akan menolak dengan BlockhashNotFound.
    return BigInt(res.value ?? 0);
  }

  async simulate(
    tx: VersionedTransaction,
    watch: string,
    tokenAccounts: string[] = [],
  ): Promise<SimulationResult> {
    const res = await this.connection.simulateTransaction(tx, {
      sigVerify: false,
      replaceRecentBlockhash: false,
      commitment: "confirmed",
      accounts: { encoding: "base64", addresses: [watch, ...tokenAccounts] },
    });
    const [acc, ...tokens] = res.value.accounts ?? [];
    return {
      err: res.value.err,
      logs: res.value.logs ?? [],
      postLamports: acc ? BigInt(acc.lamports) : null,
      postTokenAmounts: tokenAccounts.map((_, i) => {
        const t = tokens[i];
        return t ? tokenAmountOf(Buffer.from(t.data[0] ?? "", "base64")) : 0n;
      }),
      unitsConsumed: res.value.unitsConsumed ?? null,
    };
  }
}

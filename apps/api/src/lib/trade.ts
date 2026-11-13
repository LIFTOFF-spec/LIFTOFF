/**
 * Trading (Tahap 5). API membangun transaksi UNSIGNED untuk wallet pengguna dan membaca hasilnya
 * on-chain; tidak ada key yang dipegang di sini, dan signer/master wallet tidak terlibat.
 *
 * SDK Raydium dimuat lazily (hanya saat endpoint trade dipakai), sama seperti alasan
 * `@liftoff/solana/launchlab` dipisah dari entry utama.
 */
import {
  type BuiltTrade,
  type GraduatedRoute,
  type PairConfig,
  type PlatformAddresses,
  type SolanaCluster,
  type TradeErrorCode,
  type TradeQuote,
} from "@liftoff/shared";
import type { OnChainTrade, TradeEnv } from "@liftoff/solana/trade";

import type * as TradeModuleNs from "@liftoff/solana/trade";

// Hanya tipe: modul (dan SDK Raydium) dimuat lewat import() dinamis saat pertama dipakai.
type TradeModule = typeof TradeModuleNs;
import { PublicKey } from "@solana/web3.js";
import { buildTradeReceipt, type ReceiptCore } from "@liftoff/solana/receipt";
import { HttpError } from "./errors";

const TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ASSOCIATED_TOKEN_PROGRAM = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");

export interface TradeTarget {
  mint: string;
  pair: PairConfig;
}

export interface TradeParams {
  side: "buy" | "sell";
  amountIn: bigint;
  slippageBps: number;
}

export interface TradePools {
  launchPool: string;
  cpmmPool: string | null;
}

export interface TradeService {
  quote(t: TradeTarget, p: TradeParams): Promise<TradeQuote>;
  build(t: TradeTarget, p: TradeParams & { wallet: string }): Promise<BuiltTrade>;
  read(signature: string): Promise<OnChainTrade | null>;
  pools(t: TradeTarget): Promise<TradePools>;
}

/** Error dari modul trade Solana (kode + pesan aman untuk pengguna). */
function isTradeError(err: unknown): err is Error & { code: TradeErrorCode } {
  return err instanceof Error && err.name === "TradeError" && "code" in err;
}

/** Mengubah TradeError menjadi HttpError 422 dengan kode yang bisa dipetakan UI. */
export async function asHttp<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (isTradeError(err)) throw new HttpError(422, err.code, err.message);
    if (err instanceof Error && err.name === "RpcUnavailableError") {
      throw new HttpError(503, "rpc_unavailable", "Solana RPC is not responding. Try again.");
    }
    throw err;
  }
}

export class RpcTradeService implements TradeService {
  private mod: Promise<TradeModule> | null = null;
  private envP: Promise<TradeEnv> | null = null;

  constructor(
    private readonly opts: {
      rpcUrl: string;
      rpcBackupUrl?: string | null;
      cluster: SolanaCluster;
      platform: PlatformAddresses;
      referralWallet: string | null;
      graduatedRoute: GraduatedRoute;
    },
  ) {}

  private load() {
    this.mod ??= import("@liftoff/solana/trade");
    this.envP ??= import("@liftoff/solana").then(({ createConnection }) => ({
      connection: createConnection(this.opts.rpcUrl, {
        backupUrl: this.opts.rpcBackupUrl,
        cluster: this.opts.cluster,
      }),
      platform: this.opts.platform,
      referralWallet: this.opts.referralWallet,
      graduatedRoute: this.opts.graduatedRoute,
    }));
    return Promise.all([this.mod, this.envP]);
  }

  async quote(t: TradeTarget, p: TradeParams) {
    const [m, env] = await this.load();
    return m.quoteTrade(env, t, p);
  }

  async build(t: TradeTarget, p: TradeParams & { wallet: string }) {
    const [m, env] = await this.load();
    return m.buildTrade(env, t, p);
  }

  async read(signature: string) {
    const [m, env] = await this.load();
    return m.readOnChainTrade(env.connection, signature, this.opts.platform);
  }

  async pools(t: TradeTarget) {
    const [m, env] = await this.load();
    return m.poolAddressesFor(env, t);
  }
}

/** ATA SPL Token (program token klasik) milik `owner` untuk `mint`. */
export function tokenAccountOf(owner: string, mint: string): string {
  return PublicKey.findProgramAddressSync(
    [new PublicKey(owner).toBuffer(), TOKEN_PROGRAM.toBuffer(), new PublicKey(mint).toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM,
  )[0].toBase58();
}

export interface ParsedReceipt {
  receipt: ReceiptCore;
  /** Referral yang terbukti masuk ke ATA referral LIFTOFF (0 jika tidak ada). */
  referralAmount: bigint;
}

/**
 * Fee yang benar-benar terpotong, dari event program di transaksi (`buildTradeReceipt`, dipakai
 * bersama indexer Tahap 6). Transaksi hanya diterima jika menyentuh pool resmi token LIFTOFF ini.
 */
export function parseReceipt(
  trade: OnChainTrade,
  t: TradeTarget,
  pools: TradePools,
  referral: { wallet: string; ata: string } | null,
  /** Creator semua pool LIFTOFF (curve & CPMM hasil migrasi) = master wallet. */
  creator: string | null = null,
): ParsedReceipt {
  const r = buildTradeReceipt(
    trade,
    { mint: t.mint, quoteMint: t.pair.mint },
    pools,
    referral,
    creator,
  );
  if (!r.ok) throw new HttpError(422, r.code, r.message);
  return { receipt: r.receipt, referralAmount: r.referralAmount };
}

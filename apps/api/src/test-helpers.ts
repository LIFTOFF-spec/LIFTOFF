import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPrismaClient, type Db } from "@liftoff/db";
import { prepareTestDatabase, RESETTABLE_TABLES } from "@liftoff/db/testing";
import {
  base58Encode,
  StaticStonkFunAdapter,
  type QuotePriceBook,
  type SolPriceReader,
} from "@liftoff/shared";
import type { FastifyInstance } from "fastify";
import { buildApp } from "./app";
import { loadConfig, type ApiConfig } from "./config";
import { StaticTickerSource, type ExternalMatch } from "./lib/external-tickers";
import { MemoryKvStore } from "./lib/kv";
import { StaticDepositVerifier, type DepositCheck } from "./lib/deposit";
import { MemoryLaunchEnqueuer } from "./lib/launch-queue";
import type { TradeService } from "./lib/trade";
import { StaticWalletChecker, type WalletCheck } from "./lib/wallet-check";

let shared: Db | null = null;

export async function testDb(): Promise<Db> {
  shared ??= createPrismaClient(await prepareTestDatabase("liftoff_test_api"));
  return shared;
}

export async function resetDb(db: Db) {
  await db.$executeRawUnsafe(
    `TRUNCATE ${RESETTABLE_TABLES.map((t) => `"${t}"`).join(", ")} RESTART IDENTITY CASCADE`,
  );
}

/** RPC devnet palsu untuk health check (test tidak menyentuh jaringan). */
export const fakeRpcFetch: typeof fetch = async () =>
  new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "ok" }), {
    headers: { "content-type": "application/json" },
  });

export const EXTERNAL_TOKENS: ExternalMatch[] = [
  {
    symbol: "BONK",
    name: "Bonk",
    mint: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263",
    liquidityUsd: 6_000_000,
  },
  {
    symbol: "TINY",
    name: "Tiny",
    mint: "Tiny1111111111111111111111111111111111111111",
    liquidityUsd: 50,
  },
];

export interface TestAppOptions {
  config?: Partial<ApiConfig>;
  externalAvailable?: boolean;
  /** Hasil cek syarat wallet per alamat (default ok). */
  walletChecks?: Record<string, WalletCheck>;
  fetchImpl?: typeof fetch;
  /** Hasil verifikasi deposit per signature (default ok, 0,1 SOL). */
  deposit?: (signature: string) => DepositCheck;
  /** Service trade palsu (default: semua method melempar). */
  trade?: TradeService;
  /** Adapter StonkFun palsu (default: semua pair registri launchable). */
  stonkfun?: StaticStonkFunAdapter;
  /** Harga SOL/USD palsu (mainnet). Default: tidak ada, jadi USD mainnet tidak tersedia. */
  solPrice?: SolPriceReader;
  quotePrices?: Pick<QuotePriceBook, "current">;
}

const noTrade: TradeService = {
  quote: () => Promise.reject(new Error("trade service tidak dipasang di test ini")),
  build: () => Promise.reject(new Error("trade service tidak dipasang di test ini")),
  read: () => Promise.reject(new Error("trade service tidak dipasang di test ini")),
  pools: () => Promise.reject(new Error("trade service tidak dipasang di test ini")),
};

export async function makeApp(options: TestAppOptions = {}) {
  const db = await testDb();
  // Deposit launch default aktif; dimatikan di test umum agar POST /api/launch tidak butuh
  // signature transfer. Alur deposit diuji eksplisit (launch-engine.test.ts, launch.test.ts).
  const base = loadConfig({
    NODE_ENV: "test",
    SOLANA_CLUSTER: "devnet",
    LAUNCH_DEPOSIT_ENABLED: "0",
  } as NodeJS.ProcessEnv);
  const config: ApiConfig = {
    ...base,
    uploadDir: mkdtempSync(join(tmpdir(), "liftoff-uploads-")),
    ...options.config,
  };
  const kv = new MemoryKvStore();
  const launchQueue = new MemoryLaunchEnqueuer();
  const stonkfun = options.stonkfun ?? new StaticStonkFunAdapter();
  const app = buildApp({
    db,
    kv,
    external: new StaticTickerSource(EXTERNAL_TOKENS, options.externalAvailable ?? true),
    walletChecker: new StaticWalletChecker(options.walletChecks),
    launchQueue,
    depositVerifier: new StaticDepositVerifier(options.deposit),
    trade: options.trade ?? noTrade,
    stonkfun,
    solPrice: options.solPrice ?? null,
    quotePrices: options.quotePrices ?? null,
    config,
    fetchImpl: options.fetchImpl ?? fakeRpcFetch,
    logger: process.env.API_TEST_LOG === "1",
  });
  await app.ready();
  return { app, db, kv, config, launchQueue, stonkfun };
}

let ipCounter = 1;
/** IP unik per "klien" agar rate limit per IP tidak saling mengganggu antar test. */
export function nextIp() {
  ipCounter++;
  return `10.0.${Math.floor(ipCounter / 250)}.${ipCounter % 250}`;
}

/** Wallet uji: keypair ed25519 asli; alamat = public key base58 (seperti wallet Solana). */
export interface TestWallet {
  address: string;
  privateKey: KeyObject;
}

export function newWallet(): TestWallet {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const raw = Buffer.from(publicKey.export({ format: "jwk" }).x!, "base64url");
  return { address: base58Encode(raw), privateKey };
}

export function signMessage(wallet: TestWallet, message: string): string {
  return base58Encode(sign(null, Buffer.from(message, "utf8"), wallet.privateKey));
}

export interface TestSession {
  cookie: string;
  ip: string;
  wallet: TestWallet;
  user: { id: string; wallet: string };
}

/** Sign-In With Solana penuh: minta pesan, tanda tangani, verifikasi → cookie sesi. */
export async function walletLogin(
  app: FastifyInstance,
  wallet = newWallet(),
  ip = nextIp(),
): Promise<TestSession> {
  const nonce = await app.inject({
    method: "POST",
    url: "/api/auth/siws/nonce",
    payload: { wallet: wallet.address },
    remoteAddress: ip,
  });
  if (nonce.statusCode !== 200) throw new Error(`siws nonce gagal: ${nonce.body}`);
  const { message } = nonce.json() as { message: string };
  const res = await app.inject({
    method: "POST",
    url: "/api/auth/siws/verify",
    payload: { wallet: wallet.address, message, signature: signMessage(wallet, message) },
    remoteAddress: ip,
  });
  if (res.statusCode !== 200) throw new Error(`siws verify gagal: ${res.body}`);
  const cookie = res.cookies.find((c) => c.name === "liftoff_sid");
  return { cookie: `liftoff_sid=${cookie!.value}`, ip, wallet, user: res.json().user };
}

/** Menautkan akun X (mode DEV) ke sesi wallet. */
export async function devLinkX(app: FastifyInstance, session: TestSession, handle: string) {
  const res = await app.inject({
    method: "POST",
    url: "/api/auth/x/dev-link",
    headers: { cookie: session.cookie },
    payload: { handle },
    remoteAddress: session.ip,
  });
  if (res.statusCode !== 200) throw new Error(`dev-link gagal: ${res.body}`);
  return res;
}

export function launchBody(overrides: Record<string, unknown> = {}) {
  return {
    name: "Test Coin",
    ticker: "TEST",
    description: "",
    website: "",
    telegram: "",
    x: "",
    pairId: "sol",
    imageRef: null,
    ...overrides,
  };
}

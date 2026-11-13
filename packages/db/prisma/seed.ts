/**
 * Seed devnet untuk development (Tahap 3).
 *
 * Isinya adalah token dan transaksi NYATA dari PoC Tahap 1 (docs/poc-report.md): mint, pool,
 * signature launch, fee yang masuk vault per trade (atribusi indexer, sudah direkonsiliasi
 * dengan saldo vault & hasil claim), serta buyback & burn uji. Bisa dijalankan berulang
 * (idempoten); tabel ledger append-only hanya ditambah jika entrinya belum ada.
 *
 * Semua token PoC dibuat oleh master wallet devnet (docs/poc-report.md), jadi kreator seed adalah
 * user ber-wallet master tanpa akun X tertaut (bukan "verified creator").
 */
import { pairsFor, normalizeTicker } from "@liftoff/shared";
import { createPrismaClient } from "../src/index";

try {
  process.loadEnvFile(new URL("../../../.env", import.meta.url));
} catch {
  // opsional
}

const cluster = process.env.SOLANA_CLUSTER?.trim() || "devnet";
if (cluster !== "devnet") {
  throw new Error(`Seed hanya untuk devnet (SOLANA_CLUSTER=${cluster}).`);
}

const pairs = pairsFor("devnet");
const pair = (id: string) => {
  const p = pairs.find((x) => x.id === id);
  if (!p) throw new Error(`pair ${id} tidak ada`);
  return p;
};
const WSOL = pair("sol").mint;
/** Master wallet devnet PoC (pubkey saja, docs/poc-report.md). */
const MASTER_WALLET_DEVNET = "4xU25ckRqi5aeRZsAvZotvBCRcyQH3rvdPN3x5pgmCFj";

interface SeedToken {
  ticker: string;
  name: string;
  description: string;
  pairId: string;
  mint: string;
  createSignature: string;
  createdAt: string;
  graduatedAt?: string;
}

// Waktu perkiraan dari urutan eksekusi PoC 2026-10-28 (UTC).
const TOKENS: SeedToken[] = [
  {
    ticker: "LFTA",
    name: "Liftoff PoC A",
    description:
      "Tahap 1 PoC token: fee trades, referral and buyback & burn on the curve (devnet).",
    pairId: "sol",
    mint: "51roVMsQhMYmJF3YCRjfKHQTgySZhYte83CRri3eTiNo",
    createSignature:
      "2WqiyQy6Tvr39YnfaJ5qpkHg79mfAeYuwV74pT5owXZc3ynZQTY8fnfLnFiauQzxFazniKBEUR2pzJUzmpMhksCJ",
    createdAt: "2026-10-28T00:10:00Z",
  },
  {
    ticker: "LFTG",
    name: "Liftoff PoC Graduate",
    description: "Tahap 1 PoC token that graduated to Raydium CPMM; LP added and locked (devnet).",
    pairId: "sol",
    mint: "GLqjtbRYhbSah5uJ37xWLM9mbEhrEW1wAZXRPs89pryE",
    createSignature:
      "4kTAdr66C8BMG25QdQxrPkF7htxzVPtbpEH6ddqcyMkP1apJ5k2QR9gYz9Us9gpwN8FpHtVEiNC4scybMC4GNm5M",
    createdAt: "2026-10-28T00:12:00Z",
    graduatedAt: "2026-10-28T01:20:00Z",
  },
  {
    ticker: "LFTP",
    name: "Liftoff PoC Private",
    description: "Tahap 1 PoC token created with the devnet fallback (not a Jito bundle).",
    pairId: "sol",
    mint: "BkXw2yKvp2uioe1wvucNTASNMDP15L79Gmk61uwPg6uY",
    createSignature:
      "VrmTu4LEeBJRbBneqQDefP7Y1MyRvdgHKb7pQewBjYvwu2kwLYeqHtdw3MXL1YvMUjjJSajfEKoKbA7iZSSVCQs",
    createdAt: "2026-10-28T00:40:00Z",
  },
  {
    ticker: "LQSOL",
    name: "Liftoff Quote SOL-1",
    description: "Tahap 1 PoC launch on SOL global config index 1 (min raise 30 SOL).",
    pairId: "sol-1",
    mint: "J7BdswUtBqR3TSWptnCAcoYZxqkzXEfikfiEet7yjTyB",
    createSignature:
      "2urekNEZnGgLaEHG6GZMVvsc7vr5CE8SPz88vfu3aRf9Qn7i9KbPRvbjN1ise2K6NCTDbzjXZeKXef7MepSegH7V",
    createdAt: "2026-10-28T01:00:00Z",
  },
  {
    ticker: "LQUSD",
    name: "Liftoff Quote USDC",
    description: "Tahap 1 PoC launch quoted in devnet USDC.",
    pairId: "usdc",
    mint: "Bf3tLzKUE5mtVaQPutbtWS8PctQKFjzicQG1yG7vGrMz",
    createSignature:
      "5fgmUD39u4Mc6QgMvgHmpFNrFND5BtjQQuVfyZrHfKXi1tCkwUzF9iU7HWcxikjtHXoGA2YQFuYasGzK4WyHCbbD",
    createdAt: "2026-10-28T01:02:00Z",
  },
  {
    ticker: "LQRAY",
    name: "Liftoff Quote RAY",
    description: "Tahap 1 PoC launch quoted in devnet RAY.",
    pairId: "ray",
    mint: "HhgZkqBUoQJtYSJe9EHjgDAqNCnPPFPaS7kaZSJQUSPi",
    createSignature:
      "D7KBXYQYfjmRNVjuGd8wqxsPNcufHdsgi5hQvunZQaiuAFfFzvUt7PtXpbcjhgYQNEYRtbof6nwqSsR9r2mQW8j",
    createdAt: "2026-10-28T01:04:00Z",
  },
  {
    ticker: "LQOTH",
    name: "Liftoff Quote Other",
    description: "Tahap 1 PoC launch on the fifth devnet global config.",
    pairId: "devnet-8du8",
    mint: "Emix8BxGCZyT2fkrS64xR8sRGGfbBho8jt846VGdT2C",
    createSignature:
      "4Rd22T3ZUj99PHPvXJrQ7Fn91c6EoLpZ3r7dn9jcfdiZDVzNWCKdzX5BXA5KHsn6rMJ2VHdkejdbynsVBkEFdeo9",
    createdAt: "2026-10-28T01:06:00Z",
  },
];

/**
 * Δ vault platform fee per trade (lamport), dari 06-claim-platform-fee. Rekonsiliasi: 6.602.540.
 * Legacy (model sebelum Spec): dicatat `source = platform_vault`, TIDAK dihitung sebagai dana
 * LIFTOFF (Spec §9: hanya creator fee → 80/20).
 */
const FEES: Array<{ ticker: string; signature: string; amount: string; at: string }> = [
  {
    ticker: "LFTA",
    signature:
      "2tdBJrU94GGf33EbrYwC8NCEHDPYm3xfS9Jxg5pm4UiGqRctnXSUnwcYbTcSDstrRxb5HrNd2FwPJgRSSmuEVi5q",
    amount: "1000000",
    at: "2026-10-28T00:20:00Z",
  },
  {
    ticker: "LFTA",
    signature:
      "4TBgbA31BfuKneUqQN5xXEDbBbu541abUpi5s9NCySNq8wvuMm8zWBjcc2YtFQgLvsQmK94M1M2oUqtjqRJhkiLe",
    amount: "1000000",
    at: "2026-10-28T00:21:00Z",
  },
  {
    ticker: "LFTA",
    signature:
      "4dfTr6TYPRp4QEmLgvdUZxSMtMLDz28c9nBi7Xbaqo4QEAhRqmSHS6dNQCoR3ZFoy2AGGz2RWe2Pd6kRfhE9KYAk",
    amount: "1102540",
    at: "2026-10-28T00:22:00Z",
  },
  {
    ticker: "LFTA",
    signature:
      "zFv4iLMwf95bCo7T1B568uyD5dZ8tUYDbPZXNk8Th8nWxepJu49MxhMqGSTV8TPGt86rNMvFx4wPWwsdiPm1YJQ",
    amount: "3000000",
    at: "2026-10-28T00:24:00Z",
  },
  {
    ticker: "LFTP",
    signature:
      "5f1QCPVK9Smp6hgHGHLbgctqeXkP3TzzELNCoS7HyCR3K1LSd3nfepjNgnf3m5uYayqKoTW3UJnLs5GsDBBHoCW1",
    amount: "500000",
    at: "2026-10-28T00:42:00Z",
  },
];

/** Buyback & burn uji dari 08-buyback-burn (supply turun tepat sebesar amountBurned). */
const BURNS: Array<{
  ticker: string;
  amountBurned: string;
  amountSpent: string;
  buybackSignature: string;
  burnSignature: string;
  at: string;
}> = [
  {
    ticker: "LFTA",
    amountBurned: "18521402319433",
    amountSpent: "20000000",
    buybackSignature:
      "4iXn4r7goQoeDVvo9ZHXLUvoeZnJwPXAjVrnrtXB2zrDQEAmzs96EZYKj2mKbPZWqMFA1pSyUHqxVGSRdwpDCEbe",
    burnSignature:
      "4mkCJQEmRfLQ1noeKDaCfZsbfS285BGRFoJuro8N2oMg6ZMovt3sgYQfpsV4LYe1LzuhM5QfT7qka1vDgi8YNtj8",
    at: "2026-10-28T01:30:00Z",
  },
  {
    ticker: "LFTG",
    amountBurned: "7919426843313",
    amountSpent: "20000000",
    buybackSignature:
      "3qpTxjkmPntvhsaZ1NtsKds1BkqVNa3vpuMWUEYMDVvA7AYgLKwowfTR2njvGvhN29UK53dsJ1wnP6W4QqZSTN5F",
    burnSignature:
      "41DNQscpKj4BU1M6Uxgkbb5EpiWeCmSg8hZZRwEdyeqvPieNAtUMuxpd6wYje7anYzsMTtskvvVgUa3EkSh1Sa8i",
    at: "2026-10-28T01:32:00Z",
  },
];

const db = createPrismaClient();

async function main() {
  const mintOf = new Map<string, string>();

  const user = await db.user.upsert({
    where: { wallet: MASTER_WALLET_DEVNET },
    update: {},
    create: { wallet: MASTER_WALLET_DEVNET },
  });

  // Seed versi lama memakai akun X palsu `seed:poc-N`; klaim X-nya dilepas (D9 revisi).
  await db.xAccountClaim.updateMany({
    where: { xUserId: { startsWith: "seed:" }, status: "active" },
    data: { status: "released" },
  });

  for (const t of TOKENS) {
    const p = pair(t.pairId);
    const createdAt = new Date(t.createdAt);
    const tickerNormalized = normalizeTicker(t.ticker);
    const token = await db.token.upsert({
      where: { mint: t.mint },
      update: { creatorUserId: user.id },
      create: {
        name: t.name,
        ticker: t.ticker,
        tickerNormalized,
        mint: t.mint,
        description: t.description,
        links: { website: null, telegram: null, x: null },
        quoteMint: p.mint,
        quoteConfigId: p.configId,
        creatorUserId: user.id,
        launchStatus: "live",
        graduatedAt: t.graduatedAt ? new Date(t.graduatedAt) : null,
        createdAt,
      },
    });
    mintOf.set(t.ticker, t.mint);

    if (!(await db.tickerClaim.findFirst({ where: { tokenId: token.id } }))) {
      await db.tickerClaim.create({ data: { tickerNormalized, tokenId: token.id, createdAt } });
    }
    const job = await db.launchJob.upsert({
      where: { idempotencyKey: `seed-poc-${t.ticker}` },
      update: { userId: user.id },
      create: {
        tokenId: token.id,
        userId: user.id,
        idempotencyKey: `seed-poc-${t.ticker}`,
        requestHash: "seed",
        status: "live",
        attemptCount: 1,
        timeline: [
          { status: "queued", at: createdAt.toISOString() },
          { status: "live", at: createdAt.toISOString() },
        ],
        createdAt,
      },
    });
    await db.transaction.upsert({
      where: { signature: t.createSignature },
      update: {},
      create: {
        signature: t.createSignature,
        jobId: job.id,
        type: "create",
        confirmationStatus: "finalized",
        createdAt,
      },
    });
  }

  for (const f of FEES) {
    const tokenMint = mintOf.get(f.ticker)!;
    const exists = await db.feeLedger.findFirst({
      where: { sourceSignature: f.signature, tokenMint, entryType: "received" },
    });
    if (exists) continue;
    await db.feeLedger.create({
      data: {
        sourceSignature: f.signature,
        tokenMint,
        amount: f.amount,
        assetMint: WSOL,
        entryType: "received",
        attribution: "verified",
        createdAt: new Date(f.at),
      },
    });
  }

  for (const b of BURNS) {
    const exists = await db.burnLedger.findUnique({ where: { burnSignature: b.burnSignature } });
    if (exists) continue;
    await db.burnLedger.create({
      data: {
        tokenMint: mintOf.get(b.ticker)!,
        amountBurned: b.amountBurned,
        amountSpent: b.amountSpent,
        assetMint: WSOL,
        source: "buyback",
        buybackSignature: b.buybackSignature,
        burnSignature: b.burnSignature,
        createdAt: new Date(b.at),
      },
    });
  }

  await db.auditEvent.create({
    data: {
      actor: "seed",
      action: "db.seed.devnet",
      result: "ok",
      details: { tokens: TOKENS.length },
    },
  });
  console.warn(`seed devnet: ${TOKENS.length} token, ${FEES.length} fee, ${BURNS.length} burn`);
}

try {
  await main();
} finally {
  await db.$disconnect();
}

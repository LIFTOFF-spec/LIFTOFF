/**
 * Akuntansi economic engine (Tahap 7, Spec §9, §13, §20A–B, Rule 2/3/9).
 *
 * Sumber kebenaran per token tetap ledger append-only:
 *  - `received` + `allocated_buyback` / `allocated_reserve` dicatat per trade (event on-chain,
 *    trade-ledger.ts). Dana itu baru BISA DIBELANJAKAN setelah di-claim master wallet dan
 *    direkonsiliasi: entri `received` ditautkan ke claim lewat `fee_claim_items`.
 *  - Selisih claim vs ledger → entri `correction` (bucket received/buyback/reserve, attribution
 *    `estimated`) + baris `fee_reconciliations`, sehingga jumlah alokasi = fee yang benar-benar
 *    di-claim (Spec §13: alokasi tidak pernah melebihi fee yang diterima).
 *  - Budget buyback per (token, asset) = alokasi buyback yang sudah di-claim − yang sudah/sedang
 *    dibelanjakan (economic_ops buyback aktif/confirmed, burn langsung untuk fee berdenominasi
 *    token). Dipakai worker buyback DAN dicek ulang signer sebelum menandatangani.
 *  - Reserve 20% tetap per token; tidak ada jalur yang memakai saldo token lain (Rule 3).
 */
import { allocateCreatorFee, FEE_CONFIG } from "@liftoff/shared";
import { Prisma } from "./generated/prisma/client";
import type { Db, DbTx } from "./index";

type Client = Db | DbTx;

const ZERO_UUID = "00000000-0000-0000-0000-000000000000";

export interface BuybackBudget {
  tokenMint: string;
  assetMint: string;
  /** Alokasi buyback yang sudah di-claim & direkonsiliasi (termasuk koreksi). */
  claimed: bigint;
  /** Sudah dibelanjakan (confirmed) + dicadangkan operasi aktif. */
  spent: bigint;
  available: bigint;
}

/**
 * Budget buyback per (token, asset). `excludeOpId`: operasi yang sedang diperiksa (signer) tidak
 * dihitung sebagai pengeluaran, supaya bisa dibandingkan dengan amountIn-nya sendiri.
 */
export async function buybackBudgets(
  db: Client,
  opts: { tokenMint?: string; excludeOpId?: string } = {},
): Promise<BuybackBudget[]> {
  const token = opts.tokenMint ?? null;
  const exclude = opts.excludeOpId ?? ZERO_UUID;
  const rows = await db.$queryRaw<
    Array<{ tokenMint: string; assetMint: string; claimed: string; spent: string }>
  >`
    WITH linked AS (
      SELECT f."sourceSignature", f."source"
      FROM "fee_claim_items" i JOIN "fee_ledger" f ON f."id" = i."feeLedgerId"
    ),
    alloc AS (
      SELECT a."tokenMint", a."assetMint", a."amount"
      FROM "fee_ledger" a
      JOIN linked l ON l."sourceSignature" = a."sourceSignature" AND l."source" = a."source"
      WHERE a."entryType" = 'allocated_buyback' AND a."source" = 'creator_fee'
      UNION ALL
      SELECT "tokenMint", "assetMint", "amount" FROM "fee_ledger"
      WHERE "entryType" = 'correction' AND "bucket" = 'buyback'
    ),
    spent AS (
      SELECT "tokenMint", "assetMint",
        CASE WHEN "status" = 'confirmed'
          THEN coalesce(("details"->>'spentRaw')::numeric, "amountIn")
          ELSE "amountIn" END AS "amount"
      FROM "economic_ops"
      WHERE ("kind" = 'buyback' OR ("kind" = 'burn' AND "parentOpId" IS NULL))
        AND "status" IN ('pending', 'signed', 'submitted', 'confirmed')
        AND "id" <> ${exclude}::uuid
    ),
    keys AS (
      SELECT "tokenMint", "assetMint" FROM alloc UNION SELECT "tokenMint", "assetMint" FROM spent
    )
    SELECT k."tokenMint", k."assetMint",
      coalesce((SELECT sum(a."amount") FROM alloc a
                WHERE a."tokenMint" = k."tokenMint" AND a."assetMint" = k."assetMint"), 0)::text AS "claimed",
      coalesce((SELECT sum(s."amount") FROM spent s
                WHERE s."tokenMint" = k."tokenMint" AND s."assetMint" = k."assetMint"), 0)::text AS "spent"
    FROM keys k
    WHERE ${token}::text IS NULL OR k."tokenMint" = ${token}::text
    ORDER BY k."tokenMint", k."assetMint"`;
  return rows.map((r) => {
    const claimed = BigInt(r.claimed);
    const spent = BigInt(r.spent);
    return {
      tokenMint: r.tokenMint,
      assetMint: r.assetMint,
      claimed,
      spent,
      available: claimed - spent,
    };
  });
}

export interface ReserveBalance {
  tokenMint: string;
  assetMint: string;
  /** Porsi reserve dari fee yang sudah di-claim & direkonsiliasi (dana ada di akun master). */
  claimed: bigint;
  /** Seluruh alokasi reserve tercatat, termasuk yang masih menunggu claim. */
  accrued: bigint;
}

/** Saldo Conviction Reserve per (token, asset) dari ledger (Tahap 8 menambah deployment). */
export async function reserveBalances(
  db: Client,
  opts: { tokenMint?: string } = {},
): Promise<ReserveBalance[]> {
  const token = opts.tokenMint ?? null;
  const rows = await db.$queryRaw<
    Array<{ tokenMint: string; assetMint: string; claimed: string; accrued: string }>
  >`
    WITH linked AS (
      SELECT f."sourceSignature", f."source"
      FROM "fee_claim_items" i JOIN "fee_ledger" f ON f."id" = i."feeLedgerId"
    ),
    entries AS (
      SELECT a."tokenMint", a."assetMint", a."amount",
        (l."sourceSignature" IS NOT NULL) AS "isClaimed"
      FROM "fee_ledger" a
      LEFT JOIN linked l ON l."sourceSignature" = a."sourceSignature" AND l."source" = a."source"
      WHERE a."entryType" = 'allocated_reserve' AND a."source" = 'creator_fee'
      UNION ALL
      SELECT "tokenMint", "assetMint", "amount", true FROM "fee_ledger"
      WHERE "entryType" = 'correction' AND "bucket" = 'reserve'
    )
    SELECT "tokenMint", "assetMint",
      coalesce(sum("amount") FILTER (WHERE "isClaimed"), 0)::text AS "claimed",
      coalesce(sum("amount"), 0)::text AS "accrued"
    FROM entries
    WHERE ${token}::text IS NULL OR "tokenMint" = ${token}::text
    GROUP BY 1, 2 ORDER BY 1, 2`;
  return rows.map((r) => ({
    tokenMint: r.tokenMint,
    assetMint: r.assetMint,
    claimed: BigInt(r.claimed),
    accrued: BigInt(r.accrued),
  }));
}

export interface ReserveCustody extends ReserveBalance {
  /** Sudah dipindah ke akun kustodi quote token ini (reserve_fund confirmed). */
  funded: bigint;
  /** Dicadangkan reserve_fund yang masih aktif. */
  pendingFund: bigint;
  /** Quote yang sudah keluar dari kustodi lewat deployment (reserve_ledger `deployment`). */
  deployed: bigint;
  /** Batas quote reserve_deploy yang masih aktif. */
  pendingDeploy: bigint;
  /** Saldo reserve token ini = claimed − deployed (Rule 9: hanya dana yang sudah diterima). */
  balance: bigint;
  /** Masih di ATA quote master, belum dipindah ke kustodi. */
  inMaster: bigint;
  /** Di akun kustodi dan bebas dipakai deployment berikutnya. */
  inVault: bigint;
}

/**
 * Posisi reserve per (token, asset) di kustodi (Tahap 8). Satu-satunya sumber jumlah yang boleh
 * dipindah (reserve_fund) atau dideploy (reserve_deploy); dipakai worker DAN dicek ulang signer.
 * `excludeOpId`: operasi yang sedang diperiksa tidak dihitung sebagai cadangan.
 */
export async function reserveCustody(
  db: Client,
  opts: { tokenMint?: string; excludeOpId?: string } = {},
): Promise<ReserveCustody[]> {
  const exclude = opts.excludeOpId ?? ZERO_UUID;
  const base = await reserveBalances(db, opts.tokenMint ? { tokenMint: opts.tokenMint } : {});
  const ops = await db.$queryRaw<
    Array<{ tokenMint: string; assetMint: string; kind: string; active: boolean; amount: string }>
  >`
    SELECT "tokenMint", "assetMint", "kind"::text AS "kind",
      ("status" <> 'confirmed') AS "active",
      sum(CASE WHEN "status" = 'confirmed' THEN coalesce("amountOut", 0) ELSE "amountIn" END)::text AS "amount"
    FROM "economic_ops"
    WHERE "kind" IN ('reserve_fund', 'reserve_deploy')
      AND "status" IN ('pending', 'signed', 'submitted', 'confirmed')
      AND "id" <> ${exclude}::uuid
      AND (${opts.tokenMint ?? null}::text IS NULL OR "tokenMint" = ${opts.tokenMint ?? null}::text)
    GROUP BY 1, 2, 3, 4`;
  const deployedRows = await db.reserveLedger.groupBy({
    by: ["tokenMint", "assetMint"],
    where: { entryType: "deployment", ...(opts.tokenMint ? { tokenMint: opts.tokenMint } : {}) },
    _sum: { amount: true },
  });
  const key = (t: string, a: string) => `${t}|${a}`;
  const rows = new Map<string, ReserveCustody>();
  const row = (tokenMint: string, assetMint: string) => {
    let r = rows.get(key(tokenMint, assetMint));
    if (!r) {
      r = {
        tokenMint,
        assetMint,
        claimed: 0n,
        accrued: 0n,
        funded: 0n,
        pendingFund: 0n,
        deployed: 0n,
        pendingDeploy: 0n,
        balance: 0n,
        inMaster: 0n,
        inVault: 0n,
      };
      rows.set(key(tokenMint, assetMint), r);
    }
    return r;
  };
  for (const b of base) Object.assign(row(b.tokenMint, b.assetMint), b);
  for (const o of ops) {
    const r = row(o.tokenMint, o.assetMint);
    const amount = BigInt(o.amount ?? "0");
    if (o.kind === "reserve_fund") {
      if (o.active) r.pendingFund += amount;
      else r.funded += amount;
    } else if (o.active) {
      r.pendingDeploy += amount;
    }
  }
  for (const d of deployedRows) {
    row(d.tokenMint, d.assetMint).deployed = BigInt(d._sum.amount?.toFixed(0) ?? "0");
  }
  for (const r of rows.values()) {
    r.balance = r.claimed - r.deployed;
    r.inMaster = r.claimed - r.funded - r.pendingFund;
    r.inVault = r.funded - r.deployed - r.pendingDeploy;
  }
  return [...rows.values()].sort((a, b) =>
    a.tokenMint === b.tokenMint
      ? a.assetMint.localeCompare(b.assetMint)
      : a.tokenMint.localeCompare(b.tokenMint),
  );
}

/**
 * Total dana ekonomi yang seharusnya masih dipegang master wallet per asset (budget buyback belum
 * terpakai + reserve yang sudah di-claim + surplus tak teratribusi). Dibandingkan dengan saldo ATA
 * master untuk alert selisih ledger.
 */
export async function heldEconomicFunds(db: Client): Promise<Map<string, bigint>> {
  const held = new Map<string, bigint>();
  const add = (mint: string, v: bigint) => held.set(mint, (held.get(mint) ?? 0n) + v);
  for (const b of await buybackBudgets(db)) {
    // Buyback confirmed sudah keluar dari akun; operasi aktif masih memegang dananya.
    add(b.assetMint, b.claimed - b.spent);
  }
  const active = await db.economicOp.findMany({
    where: { kind: "buyback", status: { in: ["pending", "signed", "submitted"] } },
    select: { assetMint: true, amountIn: true },
  });
  for (const op of active) add(op.assetMint, BigInt(op.amountIn?.toFixed(0) ?? "0"));
  // Reserve yang sudah dipindah ke akun kustodi per token (Tahap 8) tidak lagi di ATA master.
  for (const r of await reserveCustody(db)) add(r.assetMint, r.claimed - r.funded);
  const surplus = await db.feeReconciliation.groupBy({
    by: ["assetMint"],
    _sum: { unattributedRaw: true },
  });
  for (const s of surplus) add(s.assetMint, BigInt(s._sum.unattributedRaw?.toFixed(0) ?? "0"));
  for (const [mint, v] of held) if (v === 0n) held.delete(mint);
  return held;
}

// ------------------------------------------------------------------ rekonsiliasi

export interface ClaimCandidate {
  feeLedgerId: string;
  tokenMint: string;
  amount: bigint;
  slot: bigint;
}

/**
 * Entri `received` creator fee yang belum tercakup claim mana pun dan mungkin termasuk claim ini:
 *  - claim_curve: semua trade LaunchLab berdenominasi `assetMint` (vault creator per quote mint,
 *    agregat semua token);
 *  - claim_cpmm: trade CPMM token itu dengan creator fee berdenominasi `assetMint`.
 *  - fee_forward: sama dengan claim_curve (fee curve yang diteruskan StonkFun ke master).
 * Hanya trade dengan slot ≤ slot claim (vault dikuras habis di slot itu).
 */
export async function claimCandidates(
  db: Client,
  p: {
    kind: "claim_curve" | "claim_cpmm" | "fee_forward";
    assetMint: string;
    tokenMint?: string | null;
    maxSlot: bigint;
  },
): Promise<ClaimCandidate[]> {
  // fee_forward (StonkFun): creator fee curve LaunchLab yang diteruskan, agregat per quote mint.
  const route = p.kind === "claim_cpmm" ? "cpmm" : "launchlab";
  const token = p.kind === "claim_cpmm" ? (p.tokenMint ?? "") : null;
  const rows = await db.$queryRaw<
    Array<{ id: string; tokenMint: string; amount: string; slot: bigint }>
  >`
    SELECT f."id", f."tokenMint", f."amount"::text AS "amount", r."slot"
    FROM "fee_ledger" f
    JOIN "trade_receipts" r ON r."signature" = f."sourceSignature"
    LEFT JOIN "fee_claim_items" i ON i."feeLedgerId" = f."id"
    WHERE f."entryType" = 'received' AND f."source" = 'creator_fee' AND i."feeLedgerId" IS NULL
      AND f."assetMint" = ${p.assetMint} AND r."route" = ${route} AND r."slot" <= ${p.maxSlot}
      AND (${token}::text IS NULL OR f."tokenMint" = ${token}::text)
    ORDER BY r."slot", f."createdAt"`;
  return rows.map((r) => ({
    feeLedgerId: r.id,
    tokenMint: r.tokenMint,
    amount: BigInt(r.amount),
    slot: BigInt(r.slot),
  }));
}

/**
 * Bobot pembagian fee yang diteruskan bila trade tidak punya creator fee sendiri (mainnet: fee
 * LaunchLab on-chain 0, StonkFun meneruskan dari bagiannya, per wallet): volume quote per token
 * sejak penerusan sebelumnya; bila kosong, seluruh volume sampai slot ini.
 */
export async function forwardVolumeWeights(
  db: Client,
  p: { assetMint: string; maxSlot: bigint },
): Promise<Map<string, bigint>> {
  const previous = await db.economicOp.aggregate({
    where: {
      kind: "fee_forward",
      status: "confirmed",
      assetMint: p.assetMint,
      slot: { lt: p.maxSlot },
    },
    _max: { slot: true },
  });
  const read = async (afterSlot: bigint) => {
    const rows = await db.$queryRaw<Array<{ tokenMint: string; volume: string }>>`
      SELECT "tokenMint", sum("amountQuote")::text AS "volume"
      FROM "trade_receipts"
      WHERE "quoteMint" = ${p.assetMint} AND "route" = 'launchlab'
        AND "slot" > ${afterSlot} AND "slot" <= ${p.maxSlot}
      GROUP BY 1`;
    return new Map(rows.map((r) => [r.tokenMint, BigInt(r.volume)]));
  };
  const since = await read(previous._max.slot ?? 0n);
  return since.size > 0 ? since : read(0n);
}

/** Membagi `total` (boleh negatif) pro-rata bobot, sisa pembulatan ke bobot terbesar. Σ = total. */
export function distributeProRata(
  total: bigint,
  weights: Map<string, bigint>,
): Map<string, bigint> {
  const out = new Map<string, bigint>();
  const sum = [...weights.values()].reduce((a, b) => a + b, 0n);
  if (sum <= 0n || total === 0n) return out;
  const sign = total < 0n ? -1n : 1n;
  const abs = total * sign;
  let given = 0n;
  const entries = [...weights.entries()].sort((a, b) => (b[1] > a[1] ? 1 : b[1] < a[1] ? -1 : 0));
  for (const [k, w] of entries) {
    const share = (abs * w) / sum;
    out.set(k, share);
    given += share;
  }
  const first = entries[0]![0];
  out.set(first, out.get(first)! + (abs - given));
  for (const [k, v] of out) out.set(k, v * sign);
  return out;
}

export type ReconcilePlan =
  | { action: "wait"; reason: string }
  | {
      action: "reconcile";
      status: "verified" | "estimated";
      link: ClaimCandidate[];
      ledgerRaw: bigint;
      differenceRaw: bigint;
      corrections: Map<string, bigint>;
      unattributedRaw: bigint;
    };

/**
 * Keputusan rekonsiliasi (fungsi murni). Trade di slot yang sama dengan claim bisa terjadi sebelum
 * ATAU sesudah claim di dalam slot itu, jadi dicoba dua himpunan: slot ≤ claim dan slot < claim.
 * Tidak cocok dan belum lewat masa tunggu → `wait` (indexer mungkin belum mencatat semua trade).
 */
export function planReconciliation(p: {
  claimed: bigint;
  claimSlot: bigint;
  candidates: ClaimCandidate[];
  ageMs: number;
  graceMs: number;
  /** Dipakai bila tidak ada entri `received` sama sekali (lihat forwardVolumeWeights). */
  volumeWeights?: Map<string, bigint>;
}): ReconcilePlan {
  const sum = (xs: ClaimCandidate[]) => xs.reduce((a, c) => a + c.amount, 0n);
  const all = p.candidates.filter((c) => c.slot <= p.claimSlot);
  const strict = all.filter((c) => c.slot < p.claimSlot);
  const exact = (set: ClaimCandidate[]): ReconcilePlan => ({
    action: "reconcile",
    status: "verified",
    link: set,
    ledgerRaw: sum(set),
    differenceRaw: 0n,
    corrections: new Map(),
    unattributedRaw: 0n,
  });
  if (sum(all) === p.claimed) return exact(all);
  if (sum(strict) === p.claimed) return exact(strict);
  if (p.ageMs < p.graceMs) {
    return {
      action: "wait",
      reason: `claimed ${p.claimed} ≠ ledger ${sum(all)}; menunggu indexer (${Math.round(p.ageMs / 1000)} s)`,
    };
  }
  const ledgerRaw = sum(all);
  const diff = p.claimed - ledgerRaw;
  const weights = new Map<string, bigint>();
  for (const c of all) weights.set(c.tokenMint, (weights.get(c.tokenMint) ?? 0n) + c.amount);
  if (all.length === 0) {
    for (const [mint, w] of p.volumeWeights ?? []) if (w > 0n) weights.set(mint, w);
  }
  // Surplus tanpa satu pun trade teratribusi tidak bisa dibagi ke token mana pun → ditahan.
  const unattributed = diff > 0n && weights.size === 0 ? diff : 0n;
  return {
    action: "reconcile",
    status: "estimated",
    link: all,
    ledgerRaw,
    differenceRaw: diff,
    corrections: unattributed > 0n ? new Map() : distributeProRata(diff, weights),
    unattributedRaw: unattributed,
  };
}

export interface ReconcileResult {
  assetMint: string;
  status: "verified" | "estimated" | "waiting" | "already";
  claimedRaw: bigint;
  ledgerRaw: bigint;
  differenceRaw: bigint;
  unattributedRaw: bigint;
  linked: number;
  reason?: string;
}

/**
 * Menjalankan rekonsiliasi satu claim confirmed untuk satu asset, dalam SATU transaksi DB.
 * Idempoten: unique (claimOpId, assetMint) di fee_reconciliations + PK fee_claim_items.
 */
export async function reconcileClaimAsset(
  db: Db,
  p: {
    claimOpId: string;
    kind: "claim_curve" | "claim_cpmm" | "fee_forward";
    tokenMint: string | null;
    assetMint: string;
    claimed: bigint;
    claimSlot: bigint;
    claimSignature: string;
    ageMs: number;
    graceMs: number;
  },
): Promise<ReconcileResult> {
  return db.$transaction(async (tx) => {
    // Serialisasi rekonsiliasi per asset: dua worker tidak bisa menautkan entri yang sama.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${"reconcile:" + p.assetMint}, 0))`;
    const existing = await tx.feeReconciliation.findUnique({
      where: { claimOpId_assetMint: { claimOpId: p.claimOpId, assetMint: p.assetMint } },
    });
    if (existing) {
      return {
        assetMint: p.assetMint,
        status: "already" as const,
        claimedRaw: BigInt(existing.claimedRaw.toFixed(0)),
        ledgerRaw: BigInt(existing.ledgerRaw.toFixed(0)),
        differenceRaw: BigInt(existing.differenceRaw.toFixed(0)),
        unattributedRaw: BigInt(existing.unattributedRaw.toFixed(0)),
        linked: 0,
      };
    }
    const candidates = await claimCandidates(tx, {
      kind: p.kind,
      assetMint: p.assetMint,
      tokenMint: p.tokenMint,
      maxSlot: p.claimSlot,
    });
    const plan = planReconciliation({
      claimed: p.claimed,
      claimSlot: p.claimSlot,
      candidates,
      ageMs: p.ageMs,
      graceMs: p.graceMs,
      ...(p.kind === "fee_forward" && candidates.length === 0
        ? {
            volumeWeights: await forwardVolumeWeights(tx, {
              assetMint: p.assetMint,
              maxSlot: p.claimSlot,
            }),
          }
        : {}),
    });
    if (plan.action === "wait") {
      return {
        assetMint: p.assetMint,
        status: "waiting" as const,
        claimedRaw: p.claimed,
        ledgerRaw: candidates.reduce((a, c) => a + c.amount, 0n),
        differenceRaw: 0n,
        unattributedRaw: 0n,
        linked: 0,
        reason: plan.reason,
      };
    }
    if (plan.link.length) {
      await tx.feeClaimItem.createMany({
        data: plan.link.map((c) => ({ feeLedgerId: c.feeLedgerId, claimOpId: p.claimOpId })),
      });
    }
    const tokenRows: Array<{ tokenMint: string; ledgerRaw: string; correctionRaw: string }> = [];
    const perToken = new Map<string, bigint>();
    for (const c of plan.link)
      perToken.set(c.tokenMint, (perToken.get(c.tokenMint) ?? 0n) + c.amount);
    for (const [mint, ledger] of perToken) {
      tokenRows.push({
        tokenMint: mint,
        ledgerRaw: ledger.toString(),
        correctionRaw: (plan.corrections.get(mint) ?? 0n).toString(),
      });
    }
    for (const [mint, delta] of plan.corrections) {
      if (!perToken.has(mint)) {
        tokenRows.push({ tokenMint: mint, ledgerRaw: "0", correctionRaw: delta.toString() });
      }
    }
    for (const [mint, delta] of plan.corrections) {
      if (delta === 0n) continue;
      const sign = delta < 0n ? -1n : 1n;
      const alloc = allocateCreatorFee(delta * sign, FEE_CONFIG.split);
      const base = {
        sourceSignature: p.claimSignature,
        tokenMint: mint,
        assetMint: p.assetMint,
        entryType: "correction" as const,
        source: "creator_fee" as const,
        attribution: "estimated" as const,
        relatedSignature: p.claimSignature,
        claimOpId: p.claimOpId,
      };
      await tx.feeLedger.createMany({
        data: [
          { ...base, bucket: "received", amount: new Prisma.Decimal(delta.toString()) },
          {
            ...base,
            bucket: "buyback",
            amount: new Prisma.Decimal((alloc.buybackBurn * sign).toString()),
          },
          {
            ...base,
            bucket: "reserve",
            amount: new Prisma.Decimal((alloc.convictionReserve * sign).toString()),
          },
        ],
      });
      if (alloc.convictionReserve > 0n) {
        await tx.reserveLedger.create({
          data: {
            tokenMint: mint,
            entryType: "correction",
            amount: new Prisma.Decimal((alloc.convictionReserve * sign).toString()),
            assetMint: p.assetMint,
            txSignature: p.claimSignature,
          },
        });
      }
    }
    await tx.feeReconciliation.create({
      data: {
        claimOpId: p.claimOpId,
        assetMint: p.assetMint,
        claimedRaw: new Prisma.Decimal(p.claimed.toString()),
        ledgerRaw: new Prisma.Decimal(plan.ledgerRaw.toString()),
        differenceRaw: new Prisma.Decimal(plan.differenceRaw.toString()),
        unattributedRaw: new Prisma.Decimal(plan.unattributedRaw.toString()),
        status: plan.status,
        tokens: tokenRows as Prisma.InputJsonValue,
      },
    });
    return {
      assetMint: p.assetMint,
      status: plan.status,
      claimedRaw: p.claimed,
      ledgerRaw: plan.ledgerRaw,
      differenceRaw: plan.differenceRaw,
      unattributedRaw: plan.unattributedRaw,
      linked: plan.link.length,
    };
  });
}

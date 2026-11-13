/**
 * Bangun & finalisasi operasi Conviction Reserve (Tahap 8) untuk penggerak operasi EconomicEngine.
 *
 *  reserve_fund    ATA quote master → akun kustodi quote token itu. amountOut = Δ akun kustodi.
 *  reserve_deploy  satu transaksi: swap → deposit pool CPMM token itu → burn LP. Saat confirmed:
 *                  reserve_ledger `deployment` (= quote yang benar-benar keluar dari kustodi) +
 *                  reserve_deployments (bukti publik Spec §11 Phase 5) dalam satu transaksi DB.
 */
import { Prisma, resolveTokenPair, type Db, type EconomicOp } from "@liftoff/db";
import type { SolanaCluster } from "@liftoff/shared";
import { associatedTokenAddress } from "@liftoff/solana/trade";
import type { BuiltTx } from "../launch/ports";
import type { EconomicChain, EconomicLogger, LandedTx, ReserveDeployPlanFields } from "./ports";

const dec = (v: bigint) => new Prisma.Decimal(v.toString());
const big = (d: Prisma.Decimal | null | undefined) => (d ? BigInt(d.toFixed(0)) : 0n);
const str = (details: Record<string, unknown>, k: string) => {
  const v = details[k];
  return typeof v === "string" && /^-?[0-9]+$/.test(v) ? BigInt(v) : 0n;
};

export interface ReserveOpDeps {
  db: Db;
  chain: EconomicChain;
  cluster: SolanaCluster;
  master: string;
  logger: EconomicLogger;
}

export function planFields(details: Record<string, unknown>): ReserveDeployPlanFields {
  return {
    swapIn: str(details, "swapIn"),
    swapMinOut: str(details, "swapMinOut"),
    lpAmount: str(details, "lpAmount"),
    maxQuote: str(details, "maxQuote"),
    maxToken: str(details, "maxToken"),
  };
}

export async function buildReserveOp(d: ReserveOpDeps, op: EconomicOp): Promise<BuiltTx> {
  const vault = await d.chain.reserveVault(op.tokenMint!, op.assetMint);
  if (op.kind === "reserve_fund") {
    return d.chain.buildReserveFund({
      tokenMint: op.tokenMint!,
      quoteMint: op.assetMint,
      amount: big(op.amountIn),
      createAccount: !(await d.chain.accountExists(vault.quoteAccount)),
    });
  }
  const token = await d.db.token.findUnique({ where: { mint: op.tokenMint! } });
  const pair = token ? await resolveTokenPair(d.db, d.cluster, token) : undefined;
  if (!pair) throw new Error("pair token tidak dikenal");
  const details = (op.details ?? {}) as Record<string, unknown>;
  const lpAta = associatedTokenAddress(d.master, String(details.lpMint));
  return d.chain.buildReserveDeploy({
    tokenMint: op.tokenMint!,
    pair,
    plan: planFields(details),
    createTokenAccount: !(await d.chain.accountExists(vault.tokenAccount)),
    // ATA LP ditutup (rent kembali) hanya bila kosong sebelum deposit: setelah burn kembali 0.
    closeLpAccount: (await d.chain.tokenBalance(lpAta)) === 0n,
  });
}

/** Menandai operasi reserve confirmed + mencatat ledger/bukti. Mengembalikan amountOut. */
export async function finalizeReserveOp(
  d: ReserveOpDeps,
  op: EconomicOp,
  landed: LandedTx,
  now: Date,
): Promise<void> {
  const delta = (account: string) =>
    landed.tokenDeltas.filter((t) => t.account === account).reduce((a, t) => a + t.delta, 0n);
  const vault = await d.chain.reserveVault(op.tokenMint!, op.assetMint);
  const details = { ...((op.details ?? {}) as Record<string, unknown>) };
  let amountOut = 0n;
  let deployment: Prisma.ReserveDeploymentUncheckedCreateInput | null = null;

  if (op.kind === "reserve_fund") {
    amountOut = delta(vault.quoteAccount);
    if (amountOut !== big(op.amountIn)) {
      details.verifyError = `Δ kustodi ${amountOut} ≠ jumlah transfer ${big(op.amountIn)}`;
      d.logger.warn({ opId: op.id, ...details }, "ALERT: reserve_fund tidak sesuai");
    }
  } else {
    const lpMint = String(details.lpMint);
    const lpAccount = associatedTokenAddress(d.master, lpMint);
    const pool = String(details.pool);
    const quoteDeployed = -delta(vault.quoteAccount);
    const tokenResidual = delta(vault.tokenAccount);
    const proof = await d.chain.inspectReserveDeploy(op.signature!, { lpMint, lpAccount, pool });
    const plan = planFields(details);
    const tokenBought = proof?.tokenBought ?? 0n;
    const lockVerified =
      !!proof && !proof.failed && proof.lpBurned === plan.lpAmount && proof.lpLeft === 0n;
    if (!lockVerified) {
      details.verifyError = `bukti burn LP tidak lengkap (burned ${proof?.lpBurned ?? "?"}, sisa ${proof?.lpLeft ?? "?"})`;
      d.logger.warn({ opId: op.id, ...details }, "ALERT: lock LP reserve tidak terverifikasi");
    }
    amountOut = quoteDeployed;
    const before = str(details, "reserveBeforeRaw");
    deployment = {
      opId: op.id,
      tokenMint: op.tokenMint!,
      quoteMint: op.assetMint,
      pool,
      lpMint,
      vaultQuoteAccount: vault.quoteAccount,
      vaultTokenAccount: vault.tokenAccount,
      reserveBeforeRaw: dec(before),
      quoteDeployedRaw: dec(quoteDeployed),
      swapInRaw: dec(plan.swapIn),
      tokenBoughtRaw: dec(tokenBought),
      quoteAddedRaw: dec(quoteDeployed - plan.swapIn),
      tokenAddedRaw: dec(tokenBought - tokenResidual),
      lpMintedRaw: dec(plan.lpAmount),
      lpBurnedRaw: dec(proof?.lpBurned ?? 0n),
      lockMethod: "burn",
      lockVerified,
      remainingReserveRaw: dec(before - quoteDeployed),
      tokenResidualRaw: dec(tokenResidual),
      signature: op.signature!,
      slot: BigInt(landed.slot),
      decisionId: typeof details.decisionId === "string" ? details.decisionId : null,
    };
    details.lockVerified = lockVerified;
    details.quoteDeployedRaw = quoteDeployed.toString();
  }

  await d.db.$transaction(async (tx) => {
    const moved = await tx.economicOp.updateMany({
      where: { id: op.id, status: { in: ["signed", "submitted"] } },
      data: {
        status: "confirmed",
        slot: BigInt(landed.slot),
        amountOut: dec(amountOut < 0n ? 0n : amountOut),
        details: details as Prisma.InputJsonValue,
        confirmedAt: now,
        lastError: null,
      },
    });
    if (moved.count !== 1 || !deployment) return;
    // Reserve berkurang sebesar quote yang benar-benar keluar dari kustodi (terukur on-chain).
    await tx.reserveLedger.create({
      data: {
        tokenMint: op.tokenMint!,
        entryType: "deployment",
        amount: deployment.quoteDeployedRaw,
        assetMint: op.assetMint,
        txSignature: op.signature!,
      },
    });
    await tx.reserveDeployment.create({ data: deployment });
  });
  d.logger.info(
    { opId: op.id, kind: op.kind, signature: op.signature, amountOut: amountOut.toString() },
    "operasi reserve confirmed",
  );
}

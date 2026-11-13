/**
 * Verifikasi graduation (Spec §14), fungsi murni: LIFTOFF TIDAK punya formula graduation
 * sendiri — status dibaca dari pool LaunchLab, lalu pool CPMM hasil migrasi Raydium diperiksa.
 *
 *  - pool ditemukan (PDA migrasi dari config CPMM platform, dimiliki program CPMM);
 *  - pasangan mint = token + quote mint pair, program token SPL klasik;
 *  - config pool = config CPMM tujuan migrasi platform; creator pool = master wallet
 *    (creator fee CPMM 80/20, Spec §9);
 *  - transaksi pembuat pool = migrasi oleh program LaunchLab dari curve token ini;
 *  - state LP sesuai temuan PoC Tahap 1 (e): sebagian dibakar, sisanya dipegang otoritas lock
 *    CPMM Raydium, tidak ada LP bebas saat diverifikasi (dicek on-chain, bukan diasumsikan);
 *  - add-liquidity didukung (bit deposit pool tidak dimatikan, pool sudah open).
 *
 * Reserve monitoring hanya aktif bila pool terverifikasi DAN add-liquidity didukung; jika tidak,
 * reserve deployment tetap mati sampai ada implementasi yang kompatibel.
 */
import type { GraduationCheck, GraduationState } from "@liftoff/shared";
import type { CpmmPoolSnapshot, LaunchPoolSnapshot, LpDistribution } from "@liftoff/solana/market";

/** CPMM menerima mint SPL Token klasik dan Token-2022 (token baru LIFTOFF = Token-2022). */
const TOKEN_PROGRAMS = [
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
];
/** Bit status cp-swap: 1 = deposit (add liquidity) dimatikan. */
const DEPOSIT_DISABLED_BIT = 1;

export interface GraduationInput {
  mint: string;
  quoteMint: string;
  launchPool: LaunchPoolSnapshot;
  cpmmAddress: string;
  cpmm: CpmmPoolSnapshot | null;
  expectedCpConfigId: string;
  masterWallet: string;
  /** Transaksi pembuat pool CPMM (signature tertua pool). */
  migration: { signature: string; launchlabInvoked: boolean; touchesCurve: boolean } | null;
  lp: LpDistribution | null;
  nowSec: number;
}

export interface GraduationResult {
  state: GraduationState;
  checks: GraduationCheck[];
  addLiquiditySupported: boolean;
  reserveMonitoringActive: boolean;
}

const pct = (part: bigint, total: bigint) =>
  total > 0n ? `${(Number((part * 10_000n) / total) / 100).toFixed(2)}%` : "0%";

export function evaluateGraduation(input: GraduationInput): GraduationResult {
  const p = input.launchPool;
  const none = { addLiquiditySupported: false, reserveMonitoringActive: false };
  if (p.status === 0) return { state: "not_graduated", checks: [], ...none };
  if (p.status === 1) {
    return {
      state: "migrating",
      checks: [
        {
          id: "curve_complete",
          ok: true,
          detail: "Bonding curve is full; waiting for Raydium to migrate it to a CPMM pool.",
        },
      ],
      ...none,
    };
  }
  const checks: GraduationCheck[] = [
    { id: "curve_migrated", ok: true, detail: "LaunchLab pool status = migrated (2)." },
  ];
  const cp = input.cpmm;
  if (!cp) {
    checks.push({
      id: "pool_found",
      ok: false,
      detail: `Migrated CPMM pool ${input.cpmmAddress} not readable yet.`,
    });
    return { state: "pool_pending", checks, ...none };
  }
  checks.push({
    id: "pool_found",
    ok: true,
    detail: `CPMM pool ${cp.address} owned by the Raydium CPMM program.`,
  });

  const mints = new Set([cp.mintA, cp.mintB]);
  checks.push({
    id: "pool_mints",
    ok: mints.has(input.mint) && mints.has(input.quoteMint) && mints.size === 2,
    detail: `Pool pair ${cp.mintA} / ${cp.mintB}.`,
  });
  checks.push({
    id: "token_programs",
    ok: TOKEN_PROGRAMS.includes(cp.mintProgramA) && TOKEN_PROGRAMS.includes(cp.mintProgramB),
    detail: "Both pool mints use SPL Token or Token-2022.",
  });
  checks.push({
    id: "pool_config",
    ok: cp.configId === input.expectedCpConfigId,
    detail: `Pool config ${cp.configId}; platform migration config ${input.expectedCpConfigId}.`,
  });
  checks.push({
    id: "pool_creator",
    ok: cp.poolCreator === input.masterWallet && cp.enableCreatorFee,
    detail: `Pool creator ${cp.poolCreator} (creator fee ${cp.enableCreatorFee ? "on" : "off"}); expected the LIFTOFF master wallet.`,
  });
  const m = input.migration;
  checks.push({
    id: "migration_tx",
    ok: m !== null && m.launchlabInvoked && m.touchesCurve,
    detail: m
      ? `Pool created by ${m.signature} (${m.launchlabInvoked && m.touchesCurve ? "LaunchLab migration of this curve" : "not a LaunchLab migration of this curve"}).`
      : "Pool creation transaction not found yet.",
  });
  const lp = input.lp;
  checks.push({
    id: "lp_state",
    ok: lp !== null && lp.free === 0n && lp.total > 0n,
    detail: lp
      ? `LP: ${pct(lp.burned, lp.total)} burned, ${pct(lp.locked, lp.total)} held by the Raydium CPMM lock authority, ${pct(lp.free, lp.total)} free.`
      : "LP distribution not read yet.",
  });
  const depositOpen = (cp.status & DEPOSIT_DISABLED_BIT) === 0;
  const open = cp.openTime <= BigInt(input.nowSec);
  const addLiquiditySupported = depositOpen && open;
  checks.push({
    id: "add_liquidity",
    ok: addLiquiditySupported,
    detail: addLiquiditySupported
      ? "Pool accepts deposits (Raydium CPMM add-liquidity, proven in PoC Tahap 1)."
      : `Deposits ${depositOpen ? "enabled" : "disabled"}, pool ${open ? "open" : "not open yet"}.`,
  });

  // add_liquidity tidak menggagalkan verifikasi pool; ia hanya menahan reserve monitoring.
  const verified = checks.filter((c) => c.id !== "add_liquidity").every((c) => c.ok);
  // Data yang belum terbaca (RPC) = belum bisa diputuskan, bukan gagal.
  const incomplete = m === null || lp === null;
  return {
    state: verified ? "verified" : incomplete ? "pool_pending" : "failed",
    checks,
    addLiquiditySupported,
    reserveMonitoringActive: verified && addLiquiditySupported,
  };
}

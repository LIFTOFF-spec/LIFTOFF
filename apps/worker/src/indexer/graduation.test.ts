import { describe, expect, it } from "vitest";
import { CP_CONFIG, cpmmPool, launchPool } from "./fakes";
import { evaluateGraduation, type GraduationInput } from "./graduation";

const MINT = "TokenMint111111111111111111111111111111111";
const WSOL = "So11111111111111111111111111111111111111112";
const MASTER = "4xU25ckRqi5aeRZsAvZotvBCRcyQH3rvdPN3x5pgmCFj";

function input(over: Partial<GraduationInput> = {}): GraduationInput {
  return {
    mint: MINT,
    quoteMint: WSOL,
    launchPool: launchPool("curve", MINT, WSOL, MASTER, { status: 2 }),
    cpmmAddress: "cpmm",
    cpmm: cpmmPool("cpmm", MINT, WSOL, MASTER),
    expectedCpConfigId: CP_CONFIG,
    masterWallet: MASTER,
    migration: { signature: "mig", launchlabInvoked: true, touchesCurve: true },
    lp: { total: 200n, burned: 100n, locked: 100n, free: 0n },
    nowSec: 1_900_000_000,
    ...over,
  };
}

const failed = (r: ReturnType<typeof evaluateGraduation>) =>
  r.checks.filter((c) => !c.ok).map((c) => c.id);

describe("evaluateGraduation (Spec §14)", () => {
  it("curve masih trading / menunggu migrasi", () => {
    expect(
      evaluateGraduation(input({ launchPool: launchPool("c", MINT, WSOL, MASTER) })).state,
    ).toBe("not_graduated");
    const m = evaluateGraduation(
      input({ launchPool: launchPool("c", MINT, WSOL, MASTER, { status: 1 }) }),
    );
    expect(m).toMatchObject({ state: "migrating", reserveMonitoringActive: false });
  });

  it("pool hasil migrasi sesuai PoC (LP 50% burn / 50% lock) → verified + monitoring aktif", () => {
    const r = evaluateGraduation(input());
    expect(r).toMatchObject({
      state: "verified",
      addLiquiditySupported: true,
      reserveMonitoringActive: true,
    });
    expect(r.checks.find((c) => c.id === "lp_state")!.detail).toContain("50.00% burned");
  });

  it("pool belum terbaca / data belum lengkap → pool_pending, bukan failed", () => {
    expect(evaluateGraduation(input({ cpmm: null })).state).toBe("pool_pending");
    expect(evaluateGraduation(input({ migration: null })).state).toBe("pool_pending");
    expect(evaluateGraduation(input({ lp: null })).state).toBe("pool_pending");
  });

  it("config asing, creator bukan master, LP bebas, atau bukan migrasi LaunchLab → failed", () => {
    const cases: Array<[Partial<GraduationInput>, string]> = [
      [{ cpmm: cpmmPool("cpmm", MINT, WSOL, MASTER, { configId: "x" }) }, "pool_config"],
      [{ cpmm: cpmmPool("cpmm", MINT, WSOL, "someone") }, "pool_creator"],
      [{ lp: { total: 200n, burned: 100n, locked: 50n, free: 50n } }, "lp_state"],
      [
        { migration: { signature: "m", launchlabInvoked: false, touchesCurve: true } },
        "migration_tx",
      ],
      [{ cpmm: cpmmPool("cpmm", "Other", WSOL, MASTER) }, "pool_mints"],
    ];
    for (const [over, id] of cases) {
      const r = evaluateGraduation(input(over));
      expect(r.state).toBe("failed");
      expect(failed(r)).toContain(id);
      expect(r.reserveMonitoringActive).toBe(false);
    }
  });

  it("deposit dimatikan → pool tetap verified, tetapi reserve monitoring mati", () => {
    const r = evaluateGraduation(
      input({ cpmm: cpmmPool("cpmm", MINT, WSOL, MASTER, { status: 1 }) }),
    );
    expect(r).toMatchObject({
      state: "verified",
      addLiquiditySupported: false,
      reserveMonitoringActive: false,
    });
  });
});

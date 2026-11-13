import { describe, expect, it } from "vitest";
import {
  assertValidReserveConfig,
  evaluateReserveDeployment,
  RESERVE_CONFIG,
  type ReserveDeploymentInput,
} from "./reserve-config";

describe("RESERVE_CONFIG (Spec §12)", () => {
  it("default Spec: $250, 25% per siklus, cooldown 24 jam; masih belum diverifikasi", () => {
    expect(RESERVE_CONFIG.status).toBe("unverified");
    expect(RESERVE_CONFIG.minBalanceToDeployUsd).toBe(250);
    expect(RESERVE_CONFIG.maxDeployPctPerRunBps).toBe(2_500);
    expect(RESERVE_CONFIG.cooldownSeconds).toBe(24 * 60 * 60);
  });

  it("default valid", () => {
    expect(() => assertValidReserveConfig(RESERVE_CONFIG)).not.toThrow();
  });

  it("menolak nilai negatif atau pecahan", () => {
    expect(() => assertValidReserveConfig({ ...RESERVE_CONFIG, cooldownSeconds: -1 })).toThrow(
      /cooldownSeconds/,
    );
    expect(() => assertValidReserveConfig({ ...RESERVE_CONFIG, maxPriceAgeSeconds: 1.5 })).toThrow(
      /maxPriceAgeSeconds/,
    );
  });

  it("menolak bps di atas 10_000", () => {
    expect(() =>
      assertValidReserveConfig({ ...RESERVE_CONFIG, maxDeployPctPerRunBps: 10_001 }),
    ).toThrow(/maxDeployPctPerRunBps/);
  });

  it("Opsi D dihapus (D5): tidak ada parameter kedaluwarsa", () => {
    expect(Object.keys(RESERVE_CONFIG).some((k) => /expir|inactive/i.test(k))).toBe(false);
  });
});

describe("evaluateReserveDeployment", () => {
  const DAY = 86_400;
  const ok: ReserveDeploymentInput = {
    nowSeconds: 10 * DAY,
    poolActive: true,
    graduated: true,
    poolCompatible: true,
    swapRouteAvailable: true,
    reserveBalanceUsd: 1_000,
    poolLiquidityUsd: 10_000,
    priceAgeSeconds: 30,
    oneHourMoveBps: 200,
    simulatedPriceImpactBps: 50,
    lastDeployAtSeconds: null,
    graduatedAtSeconds: 5 * DAY,
    paused: false,
  };

  it("lolos semua cek → maks 25% saldo", () => {
    const d = evaluateReserveDeployment(ok);
    expect(d).toMatchObject({ allowed: true, maxDeployUsd: 250, failedSafetyChecks: [] });
  });

  it("di bawah threshold $250 ditahan", () => {
    const d = evaluateReserveDeployment({ ...ok, reserveBalanceUsd: 249 });
    expect(d.allowed).toBe(false);
    expect(d.failedSafetyChecks).toEqual(["reserve_sufficient"]);
  });

  it("cooldown 24 jam", () => {
    expect(
      evaluateReserveDeployment({ ...ok, lastDeployAtSeconds: ok.nowSeconds - DAY + 1 }).allowed,
    ).toBe(false);
    expect(
      evaluateReserveDeployment({ ...ok, lastDeployAtSeconds: ok.nowSeconds - DAY }).allowed,
    ).toBe(true);
  });

  it("likuiditas sudah cukup dalam → tidak deploy", () => {
    expect(evaluateReserveDeployment({ ...ok, poolLiquidityUsd: 50_000 }).allowed).toBe(false);
  });

  it("semua market safety checks §12", () => {
    const d = evaluateReserveDeployment({
      ...ok,
      poolActive: false,
      graduated: false,
      swapRouteAvailable: false,
      reserveBalanceUsd: 0,
      priceAgeSeconds: null,
      oneHourMoveBps: 9_000,
    });
    expect(d.failedSafetyChecks).toEqual([
      "pool_active",
      "token_graduated",
      "swap_route_available",
      "reserve_sufficient",
      "price_data_reliable",
      "pool_state_normal",
    ]);
    expect(d.maxDeployUsd).toBe(0);
  });

  it("pool belum terverifikasi kompatibel (Rule 7) atau dipause → ditahan", () => {
    expect(evaluateReserveDeployment({ ...ok, poolCompatible: false }).allowed).toBe(false);
    expect(evaluateReserveDeployment({ ...ok, paused: true }).allowed).toBe(false);
  });
});

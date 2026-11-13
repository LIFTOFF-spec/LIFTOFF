/**
 * Simulasi / backtest sederhana parameter Conviction Reserve (Spec §12: "starting assumptions and
 * must be validated through simulation and testing"). Deterministik (PRNG ber-seed).
 *
 * Model per jam selama 180 hari setelah graduation, pool CPMM x·y = k (sisi quote dalam USD):
 *  - pool awal = target graduation CURVE_TARGET.graduationUsd (sisi quote);
 *  - volume per jam lognormal di sekitar `dailyTurnover` × likuiditas / 24, arah acak dengan drift
 *    skenario; fee pool 0,25% + creator fee 0,25% → 20% creator fee masuk reserve token itu;
 *  - skenario "crash": tiga kejadian −40% dalam satu jam (harus terdeteksi abnormal);
 *  - deployment memakai evaluateReserveDeployment (fungsi yang sama dengan worker): saldo ≥
 *    threshold, ≤ pct saldo, cooldown, likuiditas < $50k, dampak harga swap ≤ 150 bps, gerak 1 jam
 *    ≤ 30%; separuh deploy ditukar ke token lalu keduanya ditambahkan ke pool (LP dibakar).
 * Biaya jaringan per deployment ±10.000 lamport (+ rent sekali) diabaikan di bawah 0,1%.
 *
 *   pnpm --filter @liftoff/worker reserve:sim [--graduation-usd=39375]
 *
 * `--graduation-usd` mengganti ukuran pool awal (mis. graduation StonkFun asli ±$39k).
 */
import {
  CURVE_TARGET,
  evaluateReserveDeployment,
  RESERVE_CONFIG,
  type ReserveConfig,
} from "@liftoff/shared";

type Scenario = "steady" | "declining" | "crash" | "pump";
const SCENARIOS: Record<Scenario, { drift: number; turnover: number }> = {
  steady: { drift: 0, turnover: 0.5 },
  declining: { drift: -0.0015, turnover: 0.3 },
  crash: { drift: -0.0005, turnover: 0.6 },
  pump: { drift: 0.0015, turnover: 1.2 },
};

function prng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface SimResult {
  deployments: number;
  deployedUsd: number;
  maxImpactBps: number;
  /** Deployment yang terjadi pada jam dengan gerak > 30% (harus 0). */
  deploysInAbnormalHours: number;
  /** Rata-rata saldo reserve yang menganggur saat likuiditas < threshold (USD). */
  idleReserveUsd: number;
  reserveEndUsd: number;
  /** Likuiditas tambahan dari reserve terhadap pool akhir (sisi quote). */
  reserveShareOfPoolPct: number;
  poolEndUsd: number;
}

export function simulate(
  cfg: ReserveConfig,
  scenario: Scenario,
  seed: number,
  graduationUsd: number = CURVE_TARGET.graduationUsd,
): SimResult {
  const rand = prng(seed);
  const s = SCENARIOS[scenario];
  let quote = graduationUsd; // USD sisi quote
  let token = 1_000_000; // unit token (harga relatif)
  let reserve = 0;
  let lastDeploy: number | null = null;
  let priceHourAgo = quote / token;
  const res: SimResult = {
    deployments: 0,
    deployedUsd: 0,
    maxImpactBps: 0,
    deploysInAbnormalHours: 0,
    idleReserveUsd: 0,
    reserveEndUsd: 0,
    reserveShareOfPoolPct: 0,
    poolEndUsd: 0,
  };
  let reserveAdded = 0;
  let idleSum = 0;
  let idleHours = 0;
  const hours = 180 * 24;
  const crashes = scenario === "crash" ? [400, 1800, 3200] : [];

  for (let h = 0; h < hours; h++) {
    const price0 = quote / token;
    // Volume jam ini: lognormal (σ≈0,8) di sekitar turnover harian × likuiditas.
    const z = Math.sqrt(-2 * Math.log(rand() + 1e-12)) * Math.cos(2 * Math.PI * rand());
    const volume = ((s.turnover * quote) / 24) * Math.exp(0.8 * z - 0.32);
    const buyShare = 0.5 + s.drift * 100 + (rand() - 0.5) * 0.2;
    const buys = volume * Math.min(Math.max(buyShare, 0), 1);
    const sells = volume - buys;
    // Beli: quote masuk (fee 0,5% total, 0,25% creator di luar pool).
    const k = quote * token;
    quote += buys * 0.9975;
    token = k / quote;
    // Jual: token masuk senilai `sells` pada harga saat ini.
    const k2 = quote * token;
    token += (sells / (quote / token)) * 0.9975;
    quote = k2 / token;
    if (crashes.includes(h)) {
      const k3 = quote * token;
      quote *= 0.6;
      token = k3 / quote; // likuiditas & harga turun tajam (dump besar)
    }
    reserve += volume * 0.0025 * 0.2;

    const price = quote / token;
    const move = Math.round((Math.abs(price - priceHourAgo) / priceHourAgo) * 10_000);
    priceHourAgo = price0;
    const deployUsd = Math.min(
      (reserve * cfg.maxDeployPctPerRunBps) / 10_000,
      cfg.maxDeployAbsPerRunUsd,
      (quote * cfg.maxReserveShareOfPoolBps) / 10_000,
    );
    // Dampak harga swap separuh deploy di pool x·y=k.
    const swap = deployUsd / 2;
    const impactBps = Math.round(((quote + swap) ** 2 / quote ** 2 - 1) * 10_000);
    const decision = evaluateReserveDeployment(
      {
        nowSeconds: h * 3600,
        poolActive: true,
        graduated: true,
        poolCompatible: true,
        swapRouteAvailable: deployUsd > 0,
        reserveBalanceUsd: reserve,
        poolLiquidityUsd: quote,
        priceAgeSeconds: 0,
        oneHourMoveBps: move,
        simulatedPriceImpactBps: impactBps,
        lastDeployAtSeconds: lastDeploy,
        graduatedAtSeconds: -cfg.minTimeSinceGraduationSeconds,
        paused: false,
      },
      cfg,
    );
    if (quote < cfg.deployWhenLiquidityBelowUsd) {
      idleSum += reserve;
      idleHours++;
    }
    if (decision.allowed && deployUsd > 0) {
      // Swap separuh → token, lalu tambah likuiditas proporsional (sisi quote = deployUsd/2 + swap).
      const k4 = quote * token;
      quote += swap * 0.9975;
      const bought = token - k4 / quote;
      token -= bought;
      const ratio = Math.min(swap / quote, bought / token);
      quote *= 1 + ratio;
      token *= 1 + ratio;
      reserve -= deployUsd;
      reserveAdded += deployUsd;
      lastDeploy = h * 3600;
      res.deployments++;
      res.deployedUsd += deployUsd;
      res.maxImpactBps = Math.max(res.maxImpactBps, impactBps);
      if (move > cfg.abnormalMoveBps) res.deploysInAbnormalHours++;
    }
  }
  res.idleReserveUsd = idleHours ? idleSum / idleHours : 0;
  res.reserveEndUsd = reserve;
  res.poolEndUsd = quote;
  res.reserveShareOfPoolPct = (reserveAdded / quote) * 100;
  return res;
}

const VARIANTS: Array<[string, Partial<ReserveConfig>]> = [
  ["Spec ($250 · 25% · 24h)", {}],
  ["threshold $100", { minBalanceToDeployUsd: 100 }],
  ["threshold $1,000", { minBalanceToDeployUsd: 1_000 }],
  ["max 10%/cycle", { maxDeployPctPerRunBps: 1_000 }],
  ["max 50%/cycle", { maxDeployPctPerRunBps: 5_000 }],
  ["cooldown 6h", { cooldownSeconds: 6 * 3600 }],
  ["cooldown 72h", { cooldownSeconds: 72 * 3600 }],
];

if (process.argv[1]?.endsWith("reserve-sim.ts")) {
  const seeds = Array.from({ length: 20 }, (_, i) => 1_000 + i);
  const flag = process.argv.find((a) => a.startsWith("--graduation-usd="));
  const graduationUsd = flag ? Number(flag.split("=")[1]) : CURVE_TARGET.graduationUsd;
  const rows: string[] = [
    "| Variant | Scenario | Deploys/180d | Deployed USD | Max impact (bps) | Deploys in abnormal hour | Avg idle reserve while thin (USD) | Reserve share of pool |",
    "|---|---|---|---|---|---|---|---|",
  ];
  for (const [name, over] of VARIANTS) {
    for (const scenario of Object.keys(SCENARIOS) as Scenario[]) {
      const runs = seeds.map((seed) =>
        simulate({ ...RESERVE_CONFIG, ...over }, scenario, seed, graduationUsd),
      );
      const avg = (f: (r: SimResult) => number) => runs.reduce((a, r) => a + f(r), 0) / runs.length;
      const max = (f: (r: SimResult) => number) => Math.max(...runs.map(f));
      rows.push(
        `| ${name} | ${scenario} | ${avg((r) => r.deployments).toFixed(1)} | ${avg((r) => r.deployedUsd).toFixed(0)} | ${max((r) => r.maxImpactBps)} | ${max((r) => r.deploysInAbnormalHours)} | ${avg((r) => r.idleReserveUsd).toFixed(0)} | ${avg((r) => r.reserveShareOfPoolPct).toFixed(2)}% |`,
      );
    }
  }
  process.stdout.write(`${rows.join("\n")}\n`);
}

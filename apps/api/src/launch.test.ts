/**
 * Acceptance criteria launch & anti-copycat (Spec §7), dengan D9 revisi
 * (identitas = wallet/SIWS, akun X opsional):
 *  - ticker berulang (termasuk varian leetspeak/homoglyph) = indikator risiko, bukan blokir;
 *    beberapa indikator → High → diblok, bisa dibanding;
 *  - akun X tertaut kedua kalinya untuk koin aktif ditolak;
 *  - Idempotency-Key yang sama mengembalikan job yang sama;
 *  - kuota per wallet (tanpa / dengan X), batas global, syarat wallet minimum.
 */
import { randomUUID } from "node:crypto";
import { LAUNCH_DEPOSIT, platformFor } from "@liftoff/shared";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "./config";
import {
  devLinkX,
  launchBody,
  makeApp,
  newWallet,
  nextIp,
  resetDb,
  walletLogin,
  type TestSession,
} from "./test-helpers";

type Ctx = Awaited<ReturnType<typeof makeApp>>;
let ctx: Ctx;

beforeAll(async () => {
  ctx = await makeApp();
}, 120_000);
afterAll(() => ctx.app.close());
beforeEach(() => resetDb(ctx.db));

type Session = Pick<TestSession, "cookie" | "ip">;

async function launch(
  session: Session,
  body: Record<string, unknown>,
  key: string = randomUUID(),
  app = ctx.app,
) {
  return app.inject({
    method: "POST",
    url: "/api/launch",
    headers: { cookie: session.cookie, "idempotency-key": key },
    payload: body,
    remoteAddress: session.ip,
  });
}

async function validate(session: Session | null, body: Record<string, unknown>, app = ctx.app) {
  const res = await app.inject({
    method: "POST",
    url: "/api/launch/validate",
    headers: session ? { cookie: session.cookie } : {},
    payload: body,
    remoteAddress: session?.ip ?? nextIp(),
  });
  return res.json() as {
    result: string;
    reasons: Array<{ code: string; field: string }>;
    tickerNormalized: string;
    warnings: string[];
    risk: { level: string; score: number; indicators: Array<{ code: string }> } | null;
  };
}

const codes = (res: { json(): unknown }) =>
  ((res.json() as { error: { reasons?: Array<{ code: string }> } }).error.reasons ?? []).map(
    (r) => r.code,
  );

/** Mensimulasikan launch gagal (Tahap 4): klaim ticker & X dilepas. */
async function releaseClaims(tokenId: string) {
  await ctx.db.tickerClaim.updateMany({ where: { tokenId }, data: { status: "released" } });
  await ctx.db.xAccountClaim.updateMany({ where: { tokenId }, data: { status: "released" } });
  await ctx.db.token.update({ where: { id: tokenId }, data: { launchStatus: "failed" } });
}

describe("POST /api/launch", () => {
  it("wajib sign-in wallet dan header Idempotency-Key; akun X tidak wajib", async () => {
    const anon = await ctx.app.inject({
      method: "POST",
      url: "/api/launch",
      payload: launchBody(),
    });
    expect(anon.statusCode).toBe(401);

    const s = await walletLogin(ctx.app);
    const noKey = await ctx.app.inject({
      method: "POST",
      url: "/api/launch",
      headers: { cookie: s.cookie },
      payload: launchBody(),
      remoteAddress: s.ip,
    });
    expect(noKey.statusCode).toBe(400);
    expect(noKey.json().error.code).toBe("idempotency_key_required");

    // Tanpa X: launch tetap boleh, tidak ada klaim X, bukan verified creator.
    const ok = await launch(s, launchBody({ ticker: "NOX" }));
    expect(ok.statusCode).toBe(201);
    expect(await ctx.db.xAccountClaim.count()).toBe(0);
  });

  it("membuat job queued tanpa mengirim transaksi; mint belum dipublikasikan", async () => {
    const s = await walletLogin(ctx.app);
    const res = await launch(s, launchBody({ ticker: "$alpha", pairId: "usdc" }));
    expect(res.statusCode).toBe(201);
    const job = res.json();
    expect(job).toMatchObject({
      status: "queued",
      attemptCount: 0,
      mint: null,
      bundleId: null,
      token: { ticker: "ALPHA", quoteSymbol: "USDC" },
    });
    expect(await ctx.db.transaction.count()).toBe(0);

    const status = await ctx.app.inject({ method: "GET", url: `/api/launch/${job.id}` });
    expect(status.json()).toMatchObject({ id: job.id, status: "queued" });
    const token = await ctx.db.token.findUniqueOrThrow({ where: { id: job.tokenId } });
    expect(token).toMatchObject({
      tickerNormalized: "aipha", // l dan i satu kelas
      quoteConfigId: "4wHbNkobu7iARU9MbCEqDSAq6JuQreGupG2Jsf2R3DFP",
      launchStatus: "queued",
    });
  });

  it("Idempotency-Key yang sama mengembalikan job yang sama (berurutan & paralel)", async () => {
    const s = await walletLogin(ctx.app);
    const key = randomUUID();
    const body = launchBody({ ticker: "IDEM" });
    const first = await launch(s, body, key);
    const second = await launch(s, body, key);
    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(200);
    expect(second.json().id).toBe(first.json().id);

    const s2 = await walletLogin(ctx.app);
    const key2 = randomUUID();
    const parallel = await Promise.all(
      Array.from({ length: 4 }, () => launch(s2, launchBody({ ticker: "PARA" }), key2)),
    );
    const ids = new Set(parallel.map((r) => r.json().id));
    expect(parallel.every((r) => r.statusCode === 200 || r.statusCode === 201)).toBe(true);
    expect(parallel.filter((r) => r.statusCode === 201)).toHaveLength(1);
    expect(ids.size).toBe(1);
    expect(await ctx.db.launchJob.count({ where: { idempotencyKey: key2 } })).toBe(1);
  });

  it("Idempotency-Key yang dipakai ulang dengan body berbeda / wallet lain ditolak", async () => {
    const s = await walletLogin(ctx.app);
    const key = randomUUID();
    await launch(s, launchBody({ ticker: "ONE" }), key);
    const differentBody = await launch(s, launchBody({ ticker: "TWO" }), key);
    expect(differentBody.statusCode).toBe(422);
    expect(differentBody.json().error.code).toBe("idempotency_key_reused");

    const other = await walletLogin(ctx.app);
    const otherUser = await launch(other, launchBody({ ticker: "ONE" }), key);
    expect(otherUser.statusCode).toBe(409);
  });

  it("akun X tertaut: koin aktif kedua ditolak walau kuota wallet dengan X masih ada", async () => {
    const s = await walletLogin(ctx.app);
    await devLinkX(ctx.app, s, "alice");
    expect((await launch(s, launchBody({ ticker: "FIRST" }))).statusCode).toBe(201);
    const second = await launch(s, launchBody({ ticker: "SECOND" }));
    expect(second.statusCode).toBe(422);
    expect(codes(second)).toContain("x_account_has_active_token");
  });

  it("akun X yang sama meluncurkan beberapa ticker paralel: hanya satu menang", async () => {
    const s = await walletLogin(ctx.app);
    await devLinkX(ctx.app, s, "racer");
    const results = await Promise.all(
      ["RACEA", "RACEB", "RACEC"].map((ticker, i) =>
        launch({ cookie: s.cookie, ip: `10.9.0.${i + 1}` }, launchBody({ ticker })),
      ),
    );
    expect(results.filter((r) => r.statusCode === 201)).toHaveLength(1);
    for (const r of results.filter((x) => x.statusCode !== 201)) {
      expect([409, 422]).toContain(r.statusCode);
      expect(codes(r)).toContain("x_account_has_active_token");
    }
    expect(
      await ctx.db.xAccountClaim.count({ where: { xUserId: "dev:racer", status: "active" } }),
    ).toBe(1);
  });

  it("melepas lalu menautkan ulang X ke wallet lain tidak membuka koin aktif kedua", async () => {
    const a = await walletLogin(ctx.app);
    await devLinkX(ctx.app, a, "hopper");
    expect((await launch(a, launchBody({ ticker: "HOPA" }))).statusCode).toBe(201);
    await ctx.app.inject({
      method: "POST",
      url: "/api/auth/x/unlink",
      headers: { cookie: a.cookie },
    });
    const b = await walletLogin(ctx.app);
    await devLinkX(ctx.app, b, "hopper");
    const res = await launch(b, launchBody({ ticker: "HOPB" }));
    expect(res.statusCode).toBe(422);
    expect(codes(res)).toContain("x_account_has_active_token");
  });

  it("Spec §7: varian ticker yang sama dari wallet berbeda tidak otomatis diblok (Medium)", async () => {
    // Hanya varian ASCII (huruf asing tetap ditolak `ticker_non_ascii`, lihat test lain).
    const variants = ["PEPE", "pepe", "P3P3", "$pepe", "PEP3", "p3pe", "Pepe", "PEPe"];
    const sessions = await Promise.all(variants.map(() => walletLogin(ctx.app)));
    const results = [];
    for (const [i, ticker] of variants.entries()) {
      // Nama berbeda: hanya ticker yang berulang → satu indikator → Medium → boleh.
      const names = ["Alpha", "Bravo", "Charlie", "Delta", "Echo", "Foxtrot", "Golf", "Hotel"];
      results.push(await launch(sessions[i]!, launchBody({ ticker, name: `${names[i]} Project` })));
    }
    for (const r of results) expect(r.statusCode).toBe(201);
    const tokens = await ctx.db.token.findMany({ orderBy: { createdAt: "asc" } });
    expect(tokens[0]!.riskLevel).toBe("low");
    expect(tokens.slice(1).every((t) => t.riskLevel === "medium")).toBe(true);
    expect(
      await ctx.db.tickerClaim.count({ where: { tickerNormalized: "pepe", status: "active" } }),
    ).toBe(variants.length);
  });

  it("ticker + nama sama (beberapa indikator) → High → diblok dengan alasan", async () => {
    const owner = await walletLogin(ctx.app);
    expect(
      (await launch(owner, launchBody({ ticker: "MOON", name: "Moon Rocket" }))).statusCode,
    ).toBe(201);
    const copycat = await walletLogin(ctx.app);
    const res = await launch(copycat, launchBody({ ticker: "M00N", name: "Moon Rocket Official" }));
    expect(res.statusCode).toBe(422);
    expect(codes(res)).toContain("risk_high");
    expect(await ctx.db.token.count()).toBe(1);
  });

  it("menyimpan sidik jari config StonkFun di job; pair yang hilang dari StonkFun ditolak aman", async () => {
    const s = await walletLogin(ctx.app);
    const ok = await launch(s, launchBody({ ticker: "FPRINT" }));
    expect(ok.statusCode).toBe(201);
    const job = await ctx.db.launchJob.findFirstOrThrow();
    expect(job.configFingerprint).toMatch(/cfg:7ZR4zD7PYfY2XxoG1Gxcy2EgEeGYrpxrwzPuwdUBssEt/);
    expect(job.configFingerprint).toMatch(/creator:5000/);

    const sol = ctx.stonkfun.pairs.find((p) => p.id === "sol")!;
    sol.launchable = false;
    sol.unavailableReason = "Config removed by StonkFun.";
    try {
      const s2 = await walletLogin(ctx.app);
      const res = await validate(s2, launchBody({ ticker: "GONE" }));
      expect(res.reasons).toContainEqual(
        expect.objectContaining({ field: "pair", code: "pair_unsupported" }),
      );
    } finally {
      sol.launchable = true;
      sol.unavailableReason = null;
    }
  });
});
describe("anti-spam: kuota wallet, batas global, syarat wallet, deposit", () => {
  it("tanpa X: 1 launch per wallet per 24 jam (default)", async () => {
    const s = await walletLogin(ctx.app);
    expect((await launch(s, launchBody({ ticker: "QONE" }))).statusCode).toBe(201);
    const second = await launch(s, launchBody({ ticker: "QTWO" }));
    expect(second.statusCode).toBe(422);
    expect(codes(second)).toContain("wallet_daily_limit");
  });

  it("dengan X: sampai 3 launch per 24 jam (koin sebelumnya gagal), lalu ditolak", async () => {
    const s = await walletLogin(ctx.app);
    await devLinkX(ctx.app, s, "builder");
    for (const ticker of ["XONE", "XTWO", "XTRI"]) {
      const res = await launch(s, launchBody({ ticker }));
      expect(res.statusCode, ticker).toBe(201);
      await releaseClaims(res.json().tokenId);
    }
    const fourth = await launch(s, launchBody({ ticker: "XFOR" }));
    expect(fourth.statusCode).toBe(422);
    expect(codes(fourth)).toContain("wallet_daily_limit");
  });

  it("kuota wallet atomik: launch paralel dari satu wallet tanpa X → satu menang", async () => {
    const s = await walletLogin(ctx.app);
    const results = await Promise.all(
      ["PWA", "PWB", "PWC", "PWD"].map((ticker, i) =>
        launch({ cookie: s.cookie, ip: `10.8.0.${i + 1}` }, launchBody({ ticker })),
      ),
    );
    expect(results.filter((r) => r.statusCode === 201)).toHaveLength(1);
    for (const r of results.filter((x) => x.statusCode !== 201)) {
      expect([422, 429]).toContain(r.statusCode);
    }
    expect(await ctx.db.launchJob.count()).toBe(1);
  });

  it("batas launch harian global", async () => {
    const limited = await makeApp({
      config: { launchLimits: { globalPerDay: 2, perWalletPer24h: 1, perWalletWithXPer24h: 3 } },
    });
    try {
      const go = async (ticker: string) =>
        launch(await walletLogin(limited.app), launchBody({ ticker }), randomUUID(), limited.app);
      expect((await go("GONE")).statusCode).toBe(201);
      expect((await go("GTWO")).statusCode).toBe(201);
      const third = await go("GTHREE");
      expect(third.statusCode).toBe(429);
      expect(third.json().error.code).toBe("daily_limit_global");
    } finally {
      await limited.app.close();
    }
  });

  it("syarat wallet: saldo kurang / RPC tidak tersedia → ditolak dengan alasan jelas", async () => {
    const poor = newWallet();
    const offline = newWallet();
    const app = await makeApp({
      walletChecks: {
        [poor.address]: {
          status: "failed",
          code: "wallet_low_balance",
          message: "This wallet needs at least 0.05 SOL (only checked, never charged).",
        },
        [offline.address]: { status: "unavailable", error: "RPC down" },
      },
    });
    try {
      const sp = await walletLogin(app.app, poor);
      const v = await validate(sp, launchBody({ ticker: "POOR" }), app.app);
      expect(v.reasons.map((r) => `${r.field}:${r.code}`)).toContain("wallet:wallet_low_balance");
      const l = await launch(sp, launchBody({ ticker: "POOR" }), randomUUID(), app.app);
      expect(l.statusCode).toBe(422);

      const so = await walletLogin(app.app, offline);
      const v2 = await validate(so, launchBody({ ticker: "OFFW" }), app.app);
      expect(v2.reasons.map((r) => r.code)).toContain("wallet_check_unavailable");
    } finally {
      await app.app.close();
    }
  });

  it("deposit launch: default aktif dari config; rules memberi jumlah & penerima ke UI", async () => {
    // Default tanpa env = aktif (keputusan pemilik 2026-10-31); "0" mematikan.
    const env = { NODE_ENV: "test", SOLANA_CLUSTER: "devnet" } as NodeJS.ProcessEnv;
    expect(loadConfig(env).launchDeposit).toEqual(LAUNCH_DEPOSIT);
    expect(LAUNCH_DEPOSIT.enabled).toBe(true);
    expect(
      loadConfig({ ...env, LAUNCH_DEPOSIT_ENABLED: "0" } as NodeJS.ProcessEnv).launchDeposit
        .enabled,
    ).toBe(false);

    const off = await ctx.app.inject({ method: "GET", url: "/api/launch/rules" });
    expect(off.json()).toMatchObject({
      perWalletPer24h: 1,
      perWalletWithXPer24h: 3,
      minBalanceSol: "0.05",
      deposit: { enabled: false },
      remainingForWallet: null,
    });

    const { app } = await makeApp({
      config: { launchDeposit: { enabled: true, lamports: 9_000_000 } },
    });
    try {
      const on = await app.inject({ method: "GET", url: "/api/launch/rules" });
      expect(on.json().deposit).toEqual({
        enabled: true,
        sol: "0.009",
        lamports: "9000000",
        recipient: platformFor("devnet").masterWallet,
      });
    } finally {
      await app.close();
    }
    // Alur deposit (verifikasi, pemakaian ulang, refund) diuji di launch-engine.test.ts.
  });

  it("rate limit per IP untuk POST /api/launch", async () => {
    const ip = nextIp();
    const statuses: number[] = [];
    for (let i = 0; i < 7; i++) {
      const s = await walletLogin(ctx.app);
      const res = await launch(
        { cookie: s.cookie, ip },
        launchBody({ ticker: `RL${"ABCDEFG"[i]}X` }),
      );
      statuses.push(res.statusCode);
    }
    expect(statuses.slice(0, 5).every((c) => c === 201)).toBe(true);
    expect(statuses.slice(5)).toEqual([429, 429]);
  });
});

describe("POST /api/launch/validate", () => {
  it("ok untuk input valid", async () => {
    const s = await walletLogin(ctx.app);
    const res = await validate(s, launchBody({ ticker: "FRESH" }));
    expect(res).toMatchObject({ result: "ok", reasons: [], tickerNormalized: "FRESH" });
  });

  it("varian ticker yang sudah ada → indikator ticker_repeated (Medium), bukan penolakan", async () => {
    const owner = await walletLogin(ctx.app);
    await launch(owner, launchBody({ ticker: "BONKY", name: "Original Bonky" }));
    const s = await walletLogin(ctx.app);
    for (const ticker of ["BONKY", "b0nky", "B0NKY"]) {
      const res = await validate(s, launchBody({ ticker, name: "Different Thing" }));
      expect(res.result).toBe("ok");
      expect(res.risk).toMatchObject({ level: "medium", score: 1 });
      expect(res.risk!.indicators.map((i) => i.code)).toEqual(["ticker_repeated"]);
    }
  });

  it("nama mirip / identik dengan token lain dihitung sebagai indikator", async () => {
    const owner = await walletLogin(ctx.app);
    await launch(owner, launchBody({ ticker: "STARS", name: "Stargazer" }));
    const s = await walletLogin(ctx.app);
    const identical = await validate(s, launchBody({ ticker: "OTHER", name: "STARGAZER Coin" }));
    expect(identical.risk!.indicators.map((i) => i.code)).toEqual(["name_identical"]);
    const similar = await validate(s, launchBody({ ticker: "OTHER", name: "Stargazers" }));
    expect(similar.risk!.indicators.map((i) => i.code)).toEqual(["name_similar"]);
    const unrelated = await validate(s, launchBody({ ticker: "OTHER", name: "Banana Split" }));
    expect(unrelated.risk).toMatchObject({ level: "low", score: 0 });
  });

  it("akun X / website / Telegram yang dipakai token lain → High (diblok)", async () => {
    const owner = await walletLogin(ctx.app);
    const created = await launch(
      owner,
      launchBody({
        ticker: "SOCIAL",
        name: "Social One",
        website: "https://www.social-one.io/",
        telegram: "https://t.me/SocialOne",
        x: "@SocialOne",
      }),
    );
    expect(created.statusCode).toBe(201);
    const s = await walletLogin(ctx.app);
    for (const [field, value, code] of [
      ["x", "https://x.com/socialone", "social_x_reused"],
      ["website", "https://social-one.io", "social_website_reused"],
      ["telegram", "https://telegram.me/socialone", "social_telegram_reused"],
    ] as const) {
      const res = await validate(
        s,
        launchBody({ ticker: "UNIQUE", name: "Unique Name", [field]: value }),
      );
      expect(res.risk).toMatchObject({ level: "high" });
      expect(res.risk!.indicators.map((i) => i.code)).toEqual([code]);
      expect(res.reasons.map((r) => r.code)).toContain("risk_high");
    }
    // Kreator yang sama boleh memakai tautannya sendiri.
    const mine = await validate(
      owner,
      launchBody({ ticker: "SOCIAL2", name: "Social Two", website: "https://social-one.io" }),
    );
    expect(mine.risk!.indicators).toEqual([]);
  });
  it("menolak ticker non-ASCII walau belum dipakai", async () => {
    const s = await walletLogin(ctx.app);
    const res = await validate(s, launchBody({ ticker: "ЖУК" }));
    expect(res.reasons.map((r) => r.code)).toContain("ticker_non_ascii");
  });

  it("ticker yang sudah diperdagangkan di luar dengan likuiditas nyata → indikator risiko", async () => {
    const s = await walletLogin(ctx.app);
    const bonk = await validate(s, launchBody({ ticker: "B0NK" }));
    expect(bonk.risk!.indicators.map((i) => i.code)).toEqual(["ticker_external"]);
    expect(bonk.risk!.level).toBe("medium");
    const tiny = await validate(s, launchBody({ ticker: "TINY" }));
    expect(tiny).toMatchObject({ result: "ok", risk: { level: "low" } });
  });

  it("sumber data pasar tidak tersedia → fallback aman sesuai config", async () => {
    const strict = await makeApp({ externalAvailable: false });
    const lenient = await makeApp({
      externalAvailable: false,
      config: {
        antiCopycat: { ...ctx.config.antiCopycat, externalUnavailablePolicy: "allow_with_warning" },
      },
    });
    try {
      const s1 = await walletLogin(strict.app);
      const r1 = await validate(s1, launchBody({ ticker: "OFFLINE" }), strict.app);
      expect(r1.reasons.map((r) => r.code)).toContain("ticker_external_check_unavailable");
      const s2 = await walletLogin(lenient.app);
      const r2 = await validate(s2, launchBody({ ticker: "OFFLINE" }), lenient.app);
      expect(r2).toMatchObject({ result: "ok" });
      expect(r2.warnings).toHaveLength(1);
    } finally {
      await strict.app.close();
      await lenient.app.close();
    }
  });

  it("melaporkan sign-in wallet wajib, pair tak dikenal, dan URL tidak valid", async () => {
    const res = await validate(null, launchBody({ pairId: "doge", website: "http://x.com" }));
    const found = res.reasons.map((r) => `${r.field}:${r.code}`);
    expect(found).toContain("wallet:wallet_sign_in_required");
    expect(found).toContain("pair:pair_unsupported");
    expect(found).toContain("website:invalid_format");
    expect(found.some((c) => c.startsWith("x_account:"))).toBe(false);
  });
});

describe("GET /api/launch/:id", () => {
  it("404 untuk id tidak dikenal atau bukan UUID", async () => {
    for (const id of [randomUUID(), "abc"]) {
      const res = await ctx.app.inject({ method: "GET", url: `/api/launch/${id}` });
      expect(res.statusCode).toBe(404);
    }
  });
});

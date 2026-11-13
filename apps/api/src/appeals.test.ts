/**
 * Spec §7: launch High-risk diblok otomatis; kreator bisa banding, pemilik meninjau di panel
 * admin (allowlist wallet via SIWS). Banding disetujui membuka launch dengan input identik SEKALI.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  launchBody,
  makeApp,
  newWallet,
  resetDb,
  walletLogin,
  type TestSession,
} from "./test-helpers";

type Ctx = Awaited<ReturnType<typeof makeApp>>;
let ctx: Ctx;
const adminWallet = newWallet();

beforeAll(async () => {
  ctx = await makeApp({ config: { adminWallets: [adminWallet.address] } });
}, 120_000);
afterAll(() => ctx.app.close());
beforeEach(() => resetDb(ctx.db));

const req = (
  s: TestSession | null,
  method: "GET" | "POST",
  url: string,
  payload?: unknown,
  headers: Record<string, string> = {},
) =>
  ctx.app.inject({
    method,
    url,
    headers: { ...(s ? { cookie: s.cookie } : {}), ...headers },
    ...(payload !== undefined ? { payload: payload as object } : {}),
    ...(s ? { remoteAddress: s.ip } : {}),
  });

const launch = (s: TestSession, body: Record<string, unknown>) =>
  req(s, "POST", "/api/launch", body, { "idempotency-key": randomUUID() });

const COPY = launchBody({ ticker: "M00N", name: "Moon Rocket Official" });
const MESSAGE = "We are the official team; see our site for the announcement thread.";

async function seedOriginal() {
  const owner = await walletLogin(ctx.app);
  const res = await launch(owner, launchBody({ ticker: "MOON", name: "Moon Rocket" }));
  expect(res.statusCode).toBe(201);
}

describe("banding launch High-risk", () => {
  it("ajukan → admin setujui → launch identik lolos sekali; banding ditandai used", async () => {
    await seedOriginal();
    const creator = await walletLogin(ctx.app);
    const blocked = await launch(creator, COPY);
    expect(blocked.statusCode).toBe(422);

    const appeal = await req(creator, "POST", "/api/appeals", { ...COPY, message: MESSAGE });
    expect(appeal.statusCode).toBe(201);
    expect(appeal.json()).toMatchObject({
      status: "pending",
      wallet: creator.wallet.address,
      risk: { level: "high" },
    });
    const dup = await req(creator, "POST", "/api/appeals", { ...COPY, message: MESSAGE });
    expect(dup.json().error.code).toBe("appeal_exists");

    // Masih diblok sebelum ditinjau.
    expect((await launch(creator, COPY)).statusCode).toBe(422);

    const admin = await walletLogin(ctx.app, adminWallet);
    expect((await req(admin, "GET", "/api/auth/me")).json().user.isAdmin).toBe(true);
    const list = await req(admin, "GET", "/api/admin/appeals");
    expect(list.json().data).toHaveLength(1);
    const id = appeal.json().id as string;
    const review = await req(admin, "POST", `/api/admin/appeals/${id}/review`, {
      decision: "approved",
      note: "Verified the team via their site.",
    });
    expect(review.statusCode).toBe(200);
    expect(review.json()).toMatchObject({ status: "approved", reviewedBy: adminWallet.address });
    const again = await req(admin, "POST", `/api/admin/appeals/${id}/review`, {
      decision: "rejected",
    });
    expect(again.json().error.code).toBe("appeal_not_pending");

    const v = await req(creator, "POST", "/api/launch/validate", COPY);
    expect(v.json()).toMatchObject({
      result: "ok",
      risk: { level: "high", appealApproved: true },
    });
    const ok = await launch(creator, COPY);
    expect(ok.statusCode).toBe(201);
    const row = await ctx.db.launchAppeal.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe("used");
    expect(row.usedByJobId).toBe(ok.json().id);
    const token = await ctx.db.token.findUniqueOrThrow({ where: { id: ok.json().tokenId } });
    expect(token.riskLevel).toBe("high");

    // Input lain (atau sama, setelah dipakai) tidak ikut terbuka.
    const v2 = await req(creator, "POST", "/api/launch/validate", COPY);
    expect(v2.json().risk.appealApproved).toBe(false);
  });

  it("ditolak admin → tetap diblok", async () => {
    await seedOriginal();
    const creator = await walletLogin(ctx.app);
    const appeal = await req(creator, "POST", "/api/appeals", { ...COPY, message: MESSAGE });
    const admin = await walletLogin(ctx.app, adminWallet);
    await req(admin, "POST", `/api/admin/appeals/${appeal.json().id}/review`, {
      decision: "rejected",
      note: "No proof.",
    });
    const mine = await req(creator, "GET", "/api/appeals/mine");
    expect(mine.json().data[0]).toMatchObject({ status: "rejected", reviewNote: "No proof." });
    expect((await launch(creator, COPY)).statusCode).toBe(422);
  });

  it("panel admin hanya untuk allowlist wallet; banding hanya untuk launch High", async () => {
    const anon = await ctx.app.inject({ method: "GET", url: "/api/admin/appeals" });
    expect(anon.statusCode).toBe(401);
    const user = await walletLogin(ctx.app);
    expect((await req(user, "GET", "/api/admin/appeals")).statusCode).toBe(403);
    expect((await req(user, "GET", "/api/auth/me")).json().user.isAdmin).toBe(false);

    const lowRisk = await req(user, "POST", "/api/appeals", {
      ...launchBody({ ticker: "FRESH", name: "Fresh Idea" }),
      message: MESSAGE,
    });
    expect(lowRisk.json().error.code).toBe("appeal_not_needed");
    const short = await req(user, "POST", "/api/appeals", { ...COPY, message: "pls" });
    expect(short.statusCode).toBe(400);
  });
});

describe("GET /api/pairs & /api/stonkfun (Spec §6, Rule 10)", () => {
  it("pair dimuat lewat adapter; aset yang tidak tersedia dilaporkan", async () => {
    const res = (await ctx.app.inject({ method: "GET", url: "/api/pairs" })).json();
    expect(res.meta.source).toBe("onchain");
    expect(res.data.source).toBe("devnet_emulation");
    expect(res.data.pairs.map((p: { id: string }) => p.id)).toContain("sol");
    expect(res.data.unavailable).toContainEqual(expect.objectContaining({ symbol: "NVDAx" }));

    const usdc = ctx.stonkfun.pairs.find((p) => p.id === "usdc")!;
    usdc.launchLabReady = false;
    usdc.unavailableReason = "Config changed.";
    try {
      const again = (await ctx.app.inject({ method: "GET", url: "/api/pairs" })).json();
      expect(again.data.pairs.find((p: { id: string }) => p.id === "usdc")).toMatchObject({
        supported: false,
        unavailableReason: "Config changed.",
      });
    } finally {
      usdc.launchLabReady = true;
      usdc.unavailableReason = null;
    }
  });

  it("/api/stonkfun: fee on-chain dalam bps, penerima creator fee = master wallet, 80/20", async () => {
    const res = (await ctx.app.inject({ method: "GET", url: "/api/stonkfun" })).json().data;
    expect(res).toMatchObject({
      source: "devnet_emulation",
      platformFeeBps: 100,
      creatorFeeBps: 50,
      cpmmCreatorFeeBps: 25,
      split: { buybackBurnBps: 8_000, convictionReserveBps: 2_000 },
    });
  });
});

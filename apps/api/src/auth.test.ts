import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  devLinkX,
  fakeRpcFetch,
  makeApp,
  newWallet,
  nextIp,
  resetDb,
  signMessage,
  walletLogin,
} from "./test-helpers";

type Ctx = Awaited<ReturnType<typeof makeApp>>;
let ctx: Ctx;

beforeAll(async () => {
  ctx = await makeApp();
}, 120_000);
afterAll(() => ctx.app.close());
beforeEach(() => resetDb(ctx.db));

async function nonce(address: string, ip = nextIp()) {
  const res = await ctx.app.inject({
    method: "POST",
    url: "/api/auth/siws/nonce",
    payload: { wallet: address },
    remoteAddress: ip,
  });
  return (res.json() as { message: string }).message;
}

async function verify(payload: Record<string, unknown>) {
  return ctx.app.inject({
    method: "POST",
    url: "/api/auth/siws/verify",
    payload,
    remoteAddress: nextIp(),
  });
}

describe("Sign-In With Solana (identitas utama)", () => {
  it("nonce → tanda tangan → sesi; me mengembalikan wallet tanpa X", async () => {
    const anon = await ctx.app.inject({ method: "GET", url: "/api/auth/me" });
    expect(anon.json()).toEqual({ xLinkMode: "dev", user: null });

    const s = await walletLogin(ctx.app);
    const me = await ctx.app.inject({
      method: "GET",
      url: "/api/auth/me",
      headers: { cookie: s.cookie },
    });
    expect(me.json()).toMatchObject({
      xLinkMode: "dev",
      user: { wallet: s.wallet.address, xHandle: null, xDevLink: false },
    });
    expect(await ctx.db.user.count({ where: { wallet: s.wallet.address } })).toBe(1);
  });

  it("pesan menyebut wallet & menyatakan tidak ada transaksi", async () => {
    const w = newWallet();
    const message = await nonce(w.address);
    expect(message.split("\n")[1]).toBe(w.address);
    expect(message).toContain("does not send a transaction");
    expect(message).toContain("Chain ID: devnet");
  });

  it("menolak tanda tangan dari wallet lain, pesan yang diubah, dan replay nonce", async () => {
    const w = newWallet();
    const other = newWallet();
    const message = await nonce(w.address);

    const wrongKey = await verify({
      wallet: w.address,
      message,
      signature: signMessage(other, message),
    });
    expect(wrongKey.statusCode).toBe(401);
    // nonce sudah terpakai oleh percobaan gagal di atas → replay ditolak walau tanda tangan benar
    const replay = await verify({ wallet: w.address, message, signature: signMessage(w, message) });
    expect(replay.json().error.code).toBe("siws_invalid_challenge");

    const fresh = await nonce(w.address);
    const tampered = fresh.replace("Chain ID: devnet", "Chain ID: mainnet-beta");
    const res = await verify({
      wallet: w.address,
      message: tampered,
      signature: signMessage(w, tampered),
    });
    expect(res.statusCode).toBe(401);

    const msgForW = await nonce(w.address);
    const swapped = await verify({
      wallet: other.address,
      message: msgForW,
      signature: signMessage(other, msgForW),
    });
    expect(swapped.statusCode).toBe(401);
  });

  it("menolak alamat yang bukan public key Solana", async () => {
    const res = await ctx.app.inject({
      method: "POST",
      url: "/api/auth/siws/nonce",
      payload: { wallet: "legacy:abc" },
      remoteAddress: nextIp(),
    });
    expect(res.statusCode).toBe(400);
  });

  it("cookie palsu diabaikan; logout menghapus sesi", async () => {
    const forged = await ctx.app.inject({
      method: "GET",
      url: "/api/auth/me",
      headers: { cookie: "liftoff_sid=abc.def" },
    });
    expect(forged.json().user).toBeNull();

    const s = await walletLogin(ctx.app);
    await ctx.app.inject({
      method: "POST",
      url: "/api/auth/logout",
      headers: { cookie: s.cookie },
    });
    const me = await ctx.app.inject({
      method: "GET",
      url: "/api/auth/me",
      headers: { cookie: s.cookie },
    });
    expect(me.json().user).toBeNull();
  });
});

describe("akun X opsional (mode DEV link)", () => {
  it("wajib sign-in wallet dulu; tautan DEV ditandai", async () => {
    const anon = await ctx.app.inject({
      method: "POST",
      url: "/api/auth/x/dev-link",
      payload: { handle: "alice" },
      remoteAddress: nextIp(),
    });
    expect(anon.statusCode).toBe(401);

    const s = await walletLogin(ctx.app);
    const res = await devLinkX(ctx.app, s, "@Alice_01");
    expect(res.json()).toMatchObject({ user: { xHandle: "Alice_01", xDevLink: true } });
    const user = await ctx.db.user.findUniqueOrThrow({ where: { wallet: s.wallet.address } });
    expect(user.xUserId).toBe("dev:alice_01");
  });

  it("satu akun X hanya bisa tertaut ke satu wallet; unlink melepas", async () => {
    const a = await walletLogin(ctx.app);
    const b = await walletLogin(ctx.app);
    await devLinkX(ctx.app, a, "shared");
    const second = await ctx.app.inject({
      method: "POST",
      url: "/api/auth/x/dev-link",
      headers: { cookie: b.cookie },
      payload: { handle: "shared" },
      remoteAddress: b.ip,
    });
    expect(second.statusCode).toBe(409);
    expect(second.json().error.code).toBe("x_already_linked");

    await ctx.app.inject({
      method: "POST",
      url: "/api/auth/x/unlink",
      headers: { cookie: a.cookie },
    });
    expect((await devLinkX(ctx.app, b, "shared")).statusCode).toBe(200);
  });

  it("GET /api/auth/x/login → 503 dengan petunjuk dev-link", async () => {
    const s = await walletLogin(ctx.app);
    const res = await ctx.app.inject({
      method: "GET",
      url: "/api/auth/x/login",
      headers: { cookie: s.cookie },
      remoteAddress: nextIp(),
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe("x_oauth_not_configured");
  });
});

describe("OAuth 2.0 X (PKCE) untuk menautkan akun", () => {
  const xConfig = {
    clientId: "test-client",
    clientSecret: "test-secret",
    callbackUrl: "http://localhost:4000/api/auth/x/callback",
  };

  it("login (dengan sesi wallet) → X → callback menautkan; dev-link mati", async () => {
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url === "https://api.x.com/2/oauth2/token") {
        const body = new URLSearchParams(String(init?.body));
        expect(body.get("grant_type")).toBe("authorization_code");
        expect(body.get("code")).toBe("the-code");
        expect(body.get("code_verifier")).toMatch(/^[\w-]{43,128}$/);
        expect(new Headers(init?.headers).get("authorization")).toBe(
          `Basic ${Buffer.from("test-client:test-secret").toString("base64")}`,
        );
        return Response.json({ access_token: "tok", token_type: "bearer" });
      }
      if (url === "https://api.x.com/2/users/me") {
        return Response.json({ data: { id: "1234567890", username: "real_x_user", name: "Real" } });
      }
      return fakeRpcFetch(input, init);
    };
    const x = await makeApp({ config: { xOAuth: xConfig, devXLinkEnabled: false }, fetchImpl });
    try {
      const s = await walletLogin(x.app);
      const noSession = await x.app.inject({
        method: "GET",
        url: "/api/auth/x/login",
        remoteAddress: s.ip,
      });
      expect(noSession.statusCode).toBe(401);

      const login = await x.app.inject({
        method: "GET",
        url: "/api/auth/x/login?returnTo=/create",
        headers: { cookie: s.cookie },
        remoteAddress: s.ip,
      });
      expect(login.statusCode).toBe(302);
      const location = new URL(login.headers.location as string);
      expect(location.origin + location.pathname).toBe("https://x.com/i/oauth2/authorize");
      expect(location.searchParams.get("code_challenge_method")).toBe("S256");
      const state = location.searchParams.get("state")!;

      const cb = await x.app.inject({
        method: "GET",
        url: `/api/auth/x/callback?code=the-code&state=${state}`,
        headers: { cookie: s.cookie },
        remoteAddress: s.ip,
      });
      expect(cb.statusCode).toBe(302);
      expect(cb.headers.location).toBe("http://localhost:3000/create");
      const me = await x.app.inject({
        method: "GET",
        url: "/api/auth/me",
        headers: { cookie: s.cookie },
      });
      expect(me.json()).toMatchObject({
        xLinkMode: "x",
        user: { wallet: s.wallet.address, xHandle: "real_x_user", xDevLink: false },
      });

      // state sekali pakai
      const replay = await x.app.inject({
        method: "GET",
        url: `/api/auth/x/callback?code=the-code&state=${state}`,
        headers: { cookie: s.cookie },
        remoteAddress: s.ip,
      });
      expect(replay.headers.location).toContain("x_link_error=expired_state");

      const devAttempt = await x.app.inject({
        method: "POST",
        url: "/api/auth/x/dev-link",
        headers: { cookie: s.cookie },
        payload: { handle: "x" },
        remoteAddress: s.ip,
      });
      expect(devAttempt.statusCode).toBe(404);
    } finally {
      await x.app.close();
    }
  });

  it("callback dari sesi wallet lain ditolak; returnTo eksternal diabaikan", async () => {
    const x = await makeApp({ config: { xOAuth: xConfig, devXLinkEnabled: false } });
    try {
      const a = await walletLogin(x.app);
      const b = await walletLogin(x.app);
      const login = await x.app.inject({
        method: "GET",
        url: "/api/auth/x/login?returnTo=//evil.example",
        headers: { cookie: a.cookie },
        remoteAddress: a.ip,
      });
      const state = new URL(login.headers.location as string).searchParams.get("state")!;
      const stored = JSON.parse((await x.kv.get(`oauth:x:${state}`))!);
      expect(stored.returnTo).toBe("/");

      const cb = await x.app.inject({
        method: "GET",
        url: `/api/auth/x/callback?code=c&state=${state}`,
        headers: { cookie: b.cookie },
        remoteAddress: b.ip,
      });
      expect(cb.headers.location).toContain("x_link_error=session_mismatch");
    } finally {
      await x.app.close();
    }
  });
});

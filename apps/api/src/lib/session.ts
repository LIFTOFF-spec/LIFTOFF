import { randomBytes } from "node:crypto";
import type { Db } from "@liftoff/db";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { KvStore } from "./kv";

export const SESSION_COOKIE = "liftoff_sid";
const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;

/** User yang sign-in dengan wallet (SIWS). Akun X opsional. */
export interface SessionUser {
  id: string;
  wallet: string;
  xUserId: string | null;
  xHandle: string | null;
}

/** Sesi server-side di KV (Redis); cookie hanya berisi ID acak yang ditandatangani. */
export class SessionManager {
  constructor(
    private readonly kv: KvStore,
    private readonly db: Db,
  ) {}

  async create(reply: FastifyReply, userId: string, secure: boolean) {
    const sid = randomBytes(32).toString("hex");
    await this.kv.set(`sess:${sid}`, JSON.stringify({ userId }), SESSION_TTL_SECONDS);
    reply.setCookie(SESSION_COOKIE, sid, {
      path: "/",
      httpOnly: true,
      sameSite: "lax",
      secure,
      signed: true,
      maxAge: SESSION_TTL_SECONDS,
    });
  }

  private sid(req: FastifyRequest): string | null {
    const raw = req.cookies[SESSION_COOKIE];
    if (!raw) return null;
    const unsigned = req.unsignCookie(raw);
    return unsigned.valid && unsigned.value ? unsigned.value : null;
  }

  async fromRequest(req: FastifyRequest): Promise<SessionUser | null> {
    const sid = this.sid(req);
    if (!sid) return null;
    const stored = await this.kv.get(`sess:${sid}`).catch(() => null);
    if (!stored) return null;
    const { userId } = JSON.parse(stored) as { userId: string };
    const user = await this.db.user.findUnique({ where: { id: userId } });
    if (!user) return null;
    return { id: user.id, wallet: user.wallet, xUserId: user.xUserId, xHandle: user.xHandle };
  }

  async destroy(req: FastifyRequest, reply: FastifyReply) {
    const sid = this.sid(req);
    if (sid) await this.kv.del(`sess:${sid}`).catch(() => undefined);
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
  }
}

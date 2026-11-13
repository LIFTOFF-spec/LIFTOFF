import { Redis } from "ioredis";

/**
 * Key-value store kecil untuk rate limit, kuota launch, sesi, state OAuth, dan cache.
 * Produksi/development memakai Redis; test memakai implementasi memori.
 */
export interface KvStore {
  /** INCR atomik; TTL dipasang saat key baru dibuat. Mengembalikan nilai setelah increment. */
  incr(key: string, ttlSeconds: number): Promise<number>;
  decr(key: string): Promise<void>;
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
  /** Ambil lalu hapus (untuk state OAuth sekali pakai). */
  take(key: string): Promise<string | null>;
  del(key: string): Promise<void>;
  ping(): Promise<boolean>;
  close(): Promise<void>;
}

export class RedisKvStore implements KvStore {
  private readonly redis: Redis;

  constructor(url: string) {
    this.redis = new Redis(url, {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: true,
      connectTimeout: 2_000,
    });
    this.redis.on("error", () => {
      // Error koneksi dilaporkan lewat ping()/operasi; jangan crash proses.
    });
  }

  async incr(key: string, ttlSeconds: number): Promise<number> {
    const [[incrErr, value], [expErr]] = (await this.redis
      .multi()
      .incr(key)
      .expire(key, ttlSeconds, "NX")
      .exec()) as [[Error | null, number], [Error | null, unknown]];
    if (incrErr || expErr) throw incrErr ?? expErr;
    return value;
  }

  async decr(key: string): Promise<void> {
    await this.redis.decr(key);
  }

  get(key: string) {
    return this.redis.get(key);
  }

  async set(key: string, value: string, ttlSeconds: number) {
    await this.redis.set(key, value, "EX", ttlSeconds);
  }

  take(key: string) {
    return this.redis.getdel(key);
  }

  async del(key: string) {
    await this.redis.del(key);
  }

  async ping() {
    try {
      return (await this.redis.ping()) === "PONG";
    } catch {
      return false;
    }
  }

  async close() {
    this.redis.disconnect();
  }
}

export class MemoryKvStore implements KvStore {
  private readonly data = new Map<string, { value: string; expiresAt: number }>();

  constructor(private readonly now: () => number = Date.now) {}

  private live(key: string) {
    const entry = this.data.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.data.delete(key);
      return undefined;
    }
    return entry;
  }

  async incr(key: string, ttlSeconds: number) {
    const entry = this.live(key);
    const value = Number(entry?.value ?? 0) + 1;
    this.data.set(key, {
      value: String(value),
      expiresAt: entry?.expiresAt ?? this.now() + ttlSeconds * 1000,
    });
    return value;
  }

  async decr(key: string) {
    const entry = this.live(key);
    if (entry) entry.value = String(Number(entry.value) - 1);
  }

  async get(key: string) {
    return this.live(key)?.value ?? null;
  }

  async set(key: string, value: string, ttlSeconds: number) {
    this.data.set(key, { value, expiresAt: this.now() + ttlSeconds * 1000 });
  }

  async take(key: string) {
    const value = this.live(key)?.value ?? null;
    this.data.delete(key);
    return value;
  }

  async del(key: string) {
    this.data.delete(key);
  }

  async ping() {
    return true;
  }

  async close() {}
}

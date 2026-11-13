import { LAUNCH_ENGINE, LAUNCH_QUEUE } from "@liftoff/shared";
import { Queue } from "bullmq";
import { Redis } from "ioredis";

/** Mengantrekan launch job ke worker. Gagal enqueue tidak menggagalkan request: sweeper worker mengambil job `queued` dari DB. */
export interface LaunchEnqueuer {
  enqueue(jobId: string): Promise<void>;
  close(): Promise<void>;
}

export class BullMqLaunchEnqueuer implements LaunchEnqueuer {
  private readonly redis: Redis;
  private readonly queue: Queue;

  constructor(redisUrl: string) {
    this.redis = new Redis(redisUrl, { maxRetriesPerRequest: null, lazyConnect: true });
    this.redis.on("error", () => {
      // dilaporkan lewat kegagalan enqueue; sweeper worker menjadi cadangan
    });
    this.queue = new Queue(LAUNCH_QUEUE, { connection: this.redis });
  }

  async enqueue(jobId: string): Promise<void> {
    // Opsi sama dengan apps/worker (launch/queue.ts): ID BullMQ = ID launch job (dedup).
    await this.queue.add(
      "run",
      { jobId },
      {
        jobId,
        attempts: LAUNCH_ENGINE.queueAttempts,
        backoff: { type: "exponential", delay: 2_000 },
        removeOnComplete: true,
        removeOnFail: true,
      },
    );
  }

  async close() {
    await this.queue.close();
    await this.redis.quit().catch(() => undefined);
  }
}

/** Untuk test: mencatat job yang diantrekan. */
export class MemoryLaunchEnqueuer implements LaunchEnqueuer {
  readonly jobs: string[] = [];
  fail = false;

  async enqueue(jobId: string) {
    if (this.fail) throw new Error("redis down");
    this.jobs.push(jobId);
  }

  async close() {}
}

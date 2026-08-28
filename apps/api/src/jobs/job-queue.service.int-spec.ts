import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PrismaClient } from "../generated/prisma/client";
import { JobQueueService } from "./job-queue.service";
import { loadEnvForIntegrationTests } from "../testing/integration-env";

/**
 * Verifies the queue against a real database.
 *
 * Beyond the obvious round trip, this is the test that proves pg-boss (which
 * ships as ESM only) loads from the CommonJS API build at runtime.
 */

const env = loadEnvForIntegrationTests();

let prisma: PrismaClient;
let queue: JobQueueService;

const suffix = process.hrtime.bigint().toString(36);
const QUEUE_NAME = `test-queue-${suffix}`;
const SCHEDULED_QUEUE = `test-scheduled-${suffix}`;

/** Resolves when the handler runs, so the test never sleeps blindly. */
function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

beforeAll(async () => {
  prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: env.DATABASE_URL }),
  });
  queue = new JobQueueService(env);
  await queue.start();
}, 60_000);

afterAll(async () => {
  await queue.onModuleDestroy();
  await prisma.$disconnect();
});

describe("JobQueueService", () => {
  it("delivers a job payload to its worker", async () => {
    const received = deferred<{ personId: string; attempt: number }>();

    await queue.work<{ personId: string; attempt: number }>(
      QUEUE_NAME,
      (data) => {
        received.resolve(data);
      },
    );
    await queue.send(QUEUE_NAME, { personId: "person-1", attempt: 1 });

    await expect(received.promise).resolves.toEqual({
      personId: "person-1",
      attempt: 1,
    });
  }, 30_000);

  it("runs a job scheduled for a time already past", async () => {
    const received = deferred<{ apartmentNumber: string }>();

    await queue.work<{ apartmentNumber: string }>(SCHEDULED_QUEUE, (data) => {
      received.resolve(data);
    });
    // The board's move-out reminder is scheduled for the move-out date, which
    // may already have passed when the move is entered late.
    await queue.sendAt(
      SCHEDULED_QUEUE,
      { apartmentNumber: "1201" },
      new Date(Date.now() - 60_000),
    );

    await expect(received.promise).resolves.toEqual({
      apartmentNumber: "1201",
    });
  }, 30_000);

  it("creates an existing queue again without failing", async () => {
    await queue.ensureQueue(QUEUE_NAME);

    // A second service has an empty cache, so this call reaches pg-boss with a
    // queue name that already exists. Repeating the call on the same instance
    // would prove nothing: the cache returns before pg-boss is touched, so the
    // assertion would hold even if createQueue were not idempotent. Idempotence
    // is what matters, because every send() calls this.
    const second = new JobQueueService(env);
    await second.start();
    try {
      await expect(second.ensureQueue(QUEUE_NAME)).resolves.toBeUndefined();
    } finally {
      await second.onModuleDestroy();
    }
  }, 30_000);

  it("starts the backend once when two callers race to ensure a queue", async () => {
    // ensureQueue starts the backend, and several feature modules call it. Two
    // that overlap would both read `started === false` across the await and
    // start pg-boss twice.
    const service = new JobQueueService(env);
    const boss = service.instance;
    const realStart = boss.start.bind(boss);
    let starts = 0;
    boss.start = async () => {
      starts += 1;
      return realStart();
    };

    try {
      await Promise.all([
        service.ensureQueue(`test-race-a-${suffix}`),
        service.ensureQueue(`test-race-b-${suffix}`),
      ]);

      expect(starts).toBe(1);
    } finally {
      await service.onModuleDestroy();
    }
  }, 30_000);

  it("keeps its tables out of the application schema", async () => {
    const rows = await prisma.$queryRawUnsafe<{ count: bigint }[]>(
      "SELECT count(*)::bigint AS count FROM information_schema.tables WHERE table_schema = 'pgboss'",
    );

    // A queue table landing in public would collide with Prisma migrations.
    expect(Number(rows[0]?.count ?? 0)).toBeGreaterThan(0);
  });
});

import { randomBytes } from "node:crypto";

import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vite-plus/test";

import {
  financeEventQueue,
  FinanceEventsService,
} from "../finance-events/finance-events.service";
import { PrismaClient } from "../generated/prisma/client";
import { JobQueueService, pluginQueuePrefix } from "./job-queue.service";
import { waitFor } from "../testing/advisory-locks";
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
const TRANSACTION_QUEUE = `test-transaction-${suffix}`;
const RACE_QUEUES = [`test-race-a-${suffix}`, `test-race-b-${suffix}`];

/** Jobs waiting on a queue, counted in the queue's own table. */
async function queuedJobs(name: string): Promise<number> {
  const rows = await prisma.$queryRawUnsafe<{ count: bigint }[]>(
    "SELECT count(*)::bigint AS count FROM pgboss.job WHERE name = $1",
    name,
  );
  return Number(rows[0]?.count ?? 0);
}

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
  // Every queue this file creates is removed again. createQueue writes a row
  // that outlives the process, and the names carry a per-run suffix, so a suite
  // that only stopped the service would leave one behind on every run.
  for (const name of [QUEUE_NAME, SCHEDULED_QUEUE, TRANSACTION_QUEUE]) {
    await queue.instance.deleteQueue(name);
  }
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
      await Promise.all(RACE_QUEUES.map((name) => service.ensureQueue(name)));

      expect(starts).toBe(1);
    } finally {
      // In the finally, so a failed assertion still takes the two queues with
      // it rather than leaving them for the next run.
      for (const name of RACE_QUEUES) {
        await service.instance.deleteQueue(name);
      }
      await service.onModuleDestroy();
    }
  }, 30_000);

  it("stops a backend that was still starting when the process closed", async () => {
    // Shutdown decides what to do from `started`, and start() sets that only in
    // the continuation after boss.start() resolves. A destroy arriving inside
    // that window used to return at once, and the backend finished starting
    // into a process that had already closed: a pool held open and a worker
    // still polling, with nothing left that would ever stop it.
    const service = new JobQueueService(env);
    const boss = service.instance;
    const realStart = boss.start.bind(boss);
    const realStop = boss.stop.bind(boss);

    // Resolves when the start is under way; held until the shutdown has been
    // asked for, so the two overlap by construction rather than by timing.
    const underway = deferred<undefined>();
    const release = deferred<undefined>();
    let stops = 0;

    boss.start = async () => {
      underway.resolve(undefined);
      await release.promise;
      return realStart();
    };
    boss.stop = async (options?: Parameters<typeof realStop>[0]) => {
      stops += 1;
      await realStop(options);
    };

    const starting = service.start();
    await underway.promise;

    const destroying = service.onModuleDestroy();
    release.resolve(undefined);

    await starting;
    await destroying;

    expect(stops).toBe(1);
  }, 30_000);

  it("writes a job with the transaction that sent it", async () => {
    // The durability the move-out reminder and the import apply both rest on:
    // the job row is inserted by the caller's transaction, so it is there if
    // and only if the rows that decided to send it are.
    await queue.ensureQueue(TRANSACTION_QUEUE);

    await prisma.$transaction(async (tx) => {
      await queue.sendInTransaction(tx, TRANSACTION_QUEUE, { attempt: 1 });
    });

    expect(await queuedJobs(TRANSACTION_QUEUE)).toBe(1);
  }, 30_000);

  it("takes the job back when the transaction rolls back", async () => {
    await queue.ensureQueue(TRANSACTION_QUEUE);

    await expect(
      prisma.$transaction(async (tx) => {
        await queue.sendInTransaction(tx, TRANSACTION_QUEUE, { attempt: 2 });
        throw new Error("the write this job belonged to failed");
      }),
    ).rejects.toThrow("the write this job belonged to failed");

    // Still only the one from the case above: a job sent by a transaction that
    // did not commit was never sent.
    expect(await queuedJobs(TRANSACTION_QUEUE)).toBe(1);
  }, 30_000);

  it("keeps its tables out of the application schema", async () => {
    const rows = await prisma.$queryRawUnsafe<{ count: bigint }[]>(
      "SELECT count(*)::bigint AS count FROM information_schema.tables WHERE table_schema = 'pgboss'",
    );

    // A queue table landing in public would collide with Prisma migrations.
    expect(Number(rows[0]?.count ?? 0)).toBeGreaterThan(0);
  });
});

/**
 * A removed plugin's queues, deleted by the connection that has to do it in
 * production: the runtime role, which owns nothing in the job schema and may
 * create nothing there.
 *
 * The role here is one of the suite's own, given on the job schema what
 * prisma/sql/harden-runtime-role.sql gives the runtime role and nothing else,
 * because applying that script would close the worker's database to every
 * other role on the cluster.
 */
describe("deleting a removed plugin's queues as the runtime role", () => {
  const tag = suffix.replace(/[^a-z0-9]/gi, "").toLowerCase();
  const role = `openbrf_jobs_probe_${tag}`;
  const password = randomBytes(16).toString("hex");
  // Plugin ids, the second one starting with the first: what is deleted under
  // one must not reach the other.
  const pluginId = `probe_${tag}`;
  const siblingId = `${pluginId}x`;
  const prefix = pluginQueuePrefix(pluginId);
  const siblingPrefix = pluginQueuePrefix(siblingId);
  const siblingQueue = `${siblingPrefix}notify`;
  /**
   * The occurrences this file puts on pg-boss's own queue, deleted by id when
   * it ends: one sent on stays there as completed, and the queue is shared.
   */
  const forwards: string[] = [];

  let runtime: JobQueueService;
  let runtimePrisma: PrismaClient;

  /** Puts a cron occurrence on pg-boss's own queue, as a cron pass does. */
  async function forward(
    occurrence: { name: string; key: string; data: unknown; options: unknown },
    startAfter?: number,
  ): Promise<string> {
    const id = await runtime.instance.send(
      "__pgboss__send-it",
      occurrence as object,
      startAfter === undefined ? {} : { startAfter },
    );
    if (id === null) {
      throw new Error("pg-boss declined the occurrence.");
    }
    forwards.push(id);
    return id;
  }

  /** Until none of the occurrences waits or is being sent. */
  async function sentOn(ids: string[]): Promise<void> {
    await waitFor(async () => {
      const [row] = await prisma.$queryRawUnsafe<{ pending: bigint }[]>(
        `SELECT count(*)::bigint AS pending FROM pgboss.job
         WHERE name = '__pgboss__send-it' AND id = ANY($1::uuid[])
           AND state IN ('created', 'retry', 'active')`,
        ids,
      );
      return row?.pending === 0n;
    }, 25_000);
  }

  function asRole(): string {
    const url = new URL(env.DATABASE_URL);
    url.username = role;
    url.password = password;
    return url.href;
  }

  /** Rows of a job schema table under a queue name prefix. */
  async function rowsUnder(
    table: "queue" | "job" | "schedule",
    under: string,
  ): Promise<number> {
    const rows = await prisma.$queryRawUnsafe<{ count: bigint }[]>(
      `SELECT count(*)::bigint AS count FROM pgboss.${table} WHERE starts_with(name, $1)`,
      under,
    );
    return Number(rows[0]?.count ?? 0);
  }

  beforeAll(async () => {
    await prisma.$executeRawUnsafe(
      `CREATE ROLE ${role} LOGIN PASSWORD '${password}'`,
    );
    // The job schema half of harden-runtime-role.sql: rows, sequences and
    // functions, the version and the index builds read only, and no CREATE.
    for (const statement of [
      `GRANT USAGE ON SCHEMA pgboss TO ${role}`,
      `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA pgboss TO ${role}`,
      `GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA pgboss TO ${role}`,
      `GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA pgboss TO ${role}`,
      `REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON pgboss.version FROM ${role}`,
      `REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON pgboss.bam FROM ${role}`,
    ]) {
      await prisma.$executeRawUnsafe(statement);
    }
    const [stamps] = await prisma.$queryRawUnsafe<{ columns: string | null }[]>(
      `SELECT string_agg(quote_ident(attname), ', ') AS columns
       FROM pg_attribute
       WHERE attrelid = 'pgboss.version'::regclass
         AND attnum > 0 AND NOT attisdropped AND attname <> 'version'`,
    );
    if (stamps?.columns) {
      await prisma.$executeRawUnsafe(
        `GRANT UPDATE (${stamps.columns}) ON pgboss.version TO ${role}`,
      );
    }

    // Production, so the queue starts with migration off as the runtime role
    // does: it could not install anything if it tried.
    runtime = new JobQueueService({
      ...env,
      NODE_ENV: "production",
      DATABASE_URL_RUNTIME: asRole(),
    });
    await runtime.start();
    runtimePrisma = new PrismaClient({
      adapter: new PrismaPg({ connectionString: asRole() }),
    });
  }, 60_000);

  afterAll(async () => {
    // As the owner, so a failed case still takes every queue with it.
    for (const under of [prefix, siblingPrefix]) {
      await queue.deleteQueuesUnder(under);
    }
    await runtime.onModuleDestroy();
    await prisma.$executeRawUnsafe(
      `DELETE FROM pgboss.job
       WHERE name = '__pgboss__send-it' AND id = ANY($1::uuid[])`,
      forwards,
    );
    await runtimePrisma.$disconnect();
    await prisma.$executeRawUnsafe(`DROP OWNED BY ${role}`);
    await prisma.$executeRawUnsafe(`DROP ROLE IF EXISTS ${role}`);
  }, 60_000);

  it("holds no CREATE on the job schema and owns nothing in it", async () => {
    // What makes the case below mean anything: a role that owned the tables
    // could delete a queue whatever its grants said.
    const [held] = await prisma.$queryRawUnsafe<
      { create: boolean; owned: bigint }[]
    >(
      `SELECT has_schema_privilege($1, 'pgboss', 'CREATE') AS create,
         (SELECT count(*) FROM pg_class c
            JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname = 'pgboss'
             AND c.relowner = (SELECT oid FROM pg_roles WHERE rolname = $1))::bigint AS owned`,
      role,
    );
    expect(held).toEqual({ create: false, owned: 0n });
  });

  it("deletes every queue under the plugin's prefix, with its jobs and its schedules", async () => {
    // What a plugin leaves behind: a job it sent itself, with a worker on the
    // queue in this process, a cron schedule, and a finance event waiting on
    // the queue core sends those to.
    await runtime.work(`${prefix}notify`, () => undefined);
    await runtime.sendAt(
      `${prefix}notify`,
      { attempt: 1 },
      new Date(Date.now() + 3_600_000),
    );
    await runtime.schedule(`${prefix}nightly`, "0 3 * * *", { run: 1 });
    const events = new FinanceEventsService(runtime);
    events.bindServing((id) => id === pluginId);
    await events.listen(pluginId, () => undefined);
    // The worker would take the event at once; stopped first, so it is still
    // waiting when the queue is deleted.
    await runtime.instance.offWork(financeEventQueue(pluginId));
    await runtimePrisma.$transaction(async (tx) => {
      await events.publish(tx, {
        type: "memberCharge.recorded",
        chargeId: "charge-1",
      });
    });
    await runtime.send(siblingQueue, { attempt: 1 });

    expect(await rowsUnder("queue", prefix)).toBe(3);
    expect(await rowsUnder("job", prefix)).toBe(2);
    expect(await rowsUnder("schedule", prefix)).toBe(1);

    await runtime.deleteQueuesUnder(prefix);

    expect(await rowsUnder("queue", prefix)).toBe(0);
    expect(await rowsUnder("job", prefix)).toBe(0);
    expect(await rowsUnder("schedule", prefix)).toBe(0);
    // The plugin whose id starts with this one's keeps its queue and its job.
    expect(await rowsUnder("queue", siblingQueue)).toBe(1);
    expect(await queuedJobs(siblingQueue)).toBe(1);
  }, 30_000);

  it("creates a deleted queue again on its next use", async () => {
    // The service remembers which queues it has created, so it does not ask
    // again on every send. A queue deleted and still remembered would fail the
    // next package's first send under the id. The queue is the one the case
    // above deleted.
    await runtime.send(`${prefix}notify`, { attempt: 2 });

    expect(await queuedJobs(`${prefix}notify`)).toBe(1);
  }, 30_000);

  it("deletes the cron occurrences still to be sent to its queues, and no other plugin's", async () => {
    // A cron pass puts a due occurrence on pg-boss's own queue, naming the
    // schedule's queue in its data, and a worker sends it on from there
    // without asking whether the schedule is still there. Held back here, so
    // the occurrences are still waiting when the queues are deleted and when
    // the next package creates its queue again under the same name.
    const nightly = `${prefix}nightly`;
    const siblingNightly = `${siblingPrefix}nightly`;
    await runtime.schedule(nightly, "0 3 * * *", { run: 1 });
    await runtime.ensureQueue(siblingNightly);
    const occurrence = (name: string) => ({
      name,
      key: "",
      data: { run: 1 },
      options: {},
    });
    const removed = await forward(occurrence(nightly), 3_600);
    const kept = await forward(occurrence(siblingNightly), 3_600);

    await runtime.deleteQueuesUnder(prefix);
    // The next package's queue under the same name.
    await runtime.ensureQueue(nightly);
    // Both made due, and the worker sends on what is still waiting.
    await prisma.$executeRawUnsafe(
      `UPDATE pgboss.job SET start_after = now()
       WHERE name = '__pgboss__send-it' AND id = ANY($1::uuid[])`,
      [removed, kept],
    );
    // The worker sends a batch's occurrences side by side, so one job landing
    // says nothing of the other.
    await sentOn([removed, kept]);

    expect(await queuedJobs(siblingNightly)).toBe(1);
    expect(await queuedJobs(nightly)).toBe(0);
  }, 40_000);

  it("never hands the next package an occurrence a cron pass read before the deletion", async () => {
    // A cron pass reads every schedule, then puts their due occurrences on
    // pg-boss's own queue in a statement of its own. One that read this
    // plugin's schedule before its queues were deleted puts the occurrence on
    // after, in this process or any other, where the deletion can neither see
    // it nor wait for it.
    const late = `${prefix}late`;
    const siblingLate = `${siblingPrefix}late`;
    await runtime.schedule(late, "0 3 * * *", { from: "removed" });
    await runtime.schedule(siblingLate, "0 3 * * *", { from: "sibling" });
    const read = async (name: string) => {
      const schedule = await runtime.instance.getSchedule(name);
      if (schedule === null) {
        throw new Error("The schedule is not there.");
      }
      return schedule;
    };
    // What the pass read, held until the deletion is over.
    const held = [await read(late), await read(siblingLate)];

    await runtime.deleteQueuesUnder(prefix);

    // The next package under the id: its own worker and schedule on the queue
    // of the same name, made again.
    const received: unknown[] = [];
    const siblingReceived: unknown[] = [];
    await runtime.work(late, (data) => {
      received.push(data);
    });
    await runtime.work(siblingLate, (data) => {
      siblingReceived.push(data);
    });
    await runtime.schedule(late, "0 3 * * *", { from: "next" });
    const next = await read(late);

    // The held pass puts its occurrences on now, and a later pass the next
    // package's own. Then the worker sends them on, and the handlers run.
    const ids: string[] = [];
    for (const { name, key, data, options } of [...held, next]) {
      ids.push(await forward({ name, key, data, options }));
    }
    await sentOn(ids);
    await waitFor(async () => {
      const [row] = await prisma.$queryRawUnsafe<{ waiting: bigint }[]>(
        `SELECT count(*)::bigint AS waiting FROM pgboss.job
         WHERE name = ANY($1::text[]) AND state IN ('created', 'retry', 'active')`,
        [late, siblingLate],
      );
      return (
        row?.waiting === 0n && received.length + siblingReceived.length > 1
      );
    }, 25_000);

    expect(received).toEqual([{ from: "next" }]);
    // The plugin whose id starts with this one's keeps what it scheduled.
    expect(siblingReceived).toEqual([{ from: "sibling" }]);
  }, 60_000);

  it("never hands the next package what a schedule an earlier release made holds", async () => {
    // Schedules as an earlier release wrote them, with the data on its own:
    // one of this plugin's, left by a removal made on that release or one it
    // never schedules again, and one of the plugin whose id starts with this
    // one's.
    const legacy = `${prefix}legacy`;
    const siblingLegacy = `${siblingPrefix}legacy`;
    for (const [name, from] of [
      [legacy, "removed"],
      [siblingLegacy, "sibling"],
    ] as const) {
      await runtime.ensureQueue(name);
      await prisma.$executeRawUnsafe(
        `INSERT INTO pgboss.schedule (name, key, cron, data, options)
         VALUES ($1, '', '0 3 * * *', $2::jsonb, '{}'::jsonb)`,
        name,
        JSON.stringify({ privateFromPreviousPackage: from }),
      );
    }

    // This release starting on the host, as the runtime role: its cron passes
    // read the schedules from here on.
    const upgraded = new JobQueueService({
      ...env,
      NODE_ENV: "production",
      DATABASE_URL_RUNTIME: asRole(),
    });
    try {
      await upgraded.start();
    } finally {
      await upgraded.onModuleDestroy();
    }
    const read = async (name: string) => {
      const schedule = await runtime.instance.getSchedule(name);
      if (schedule === null) {
        throw new Error("The schedule is not there.");
      }
      return schedule;
    };
    // What a pass read, held until the deletion and the next package's queue.
    const held = [await read(legacy), await read(siblingLegacy)];

    await runtime.deleteQueuesUnder(prefix);

    // The next package under the id: its worker on the queue of the same
    // name, made again, a schedule of its own and a job it sends directly.
    const received: unknown[] = [];
    const siblingReceived: unknown[] = [];
    await runtime.work(legacy, (data) => {
      received.push(data);
    });
    await runtime.work(siblingLegacy, (data) => {
      siblingReceived.push(data);
    });
    await runtime.schedule(legacy, "0 3 * * *", { from: "next" });
    const next = await read(legacy);
    await runtime.send(legacy, { sent: "next" });

    // The held pass puts its occurrences on now, a later pass the next
    // package's own, and the worker sends them on to the handlers.
    const ids: string[] = [];
    for (const { name, key, data, options } of [...held, next]) {
      ids.push(await forward({ name, key, data, options }));
    }
    await sentOn(ids);
    await waitFor(async () => {
      const [row] = await prisma.$queryRawUnsafe<{ waiting: bigint }[]>(
        `SELECT count(*)::bigint AS waiting FROM pgboss.job
         WHERE name = ANY($1::text[]) AND state IN ('created', 'retry', 'active')`,
        [legacy, siblingLegacy],
      );
      return (
        row?.waiting === 0n &&
        received.length >= 2 &&
        siblingReceived.length >= 1
      );
    }, 25_000);

    expect(received).toHaveLength(2);
    expect(received).toEqual(
      expect.arrayContaining([{ from: "next" }, { sent: "next" }]),
    );
    // The sibling's schedule hands its handler the data it was given.
    expect(siblingReceived).toEqual([
      { privateFromPreviousPackage: "sibling" },
    ]);
  }, 60_000);

  it("deletes an occurrence that fails while being sent, once it waits again", async () => {
    // pg-boss sends an occurrence on with a retry left. Being sent while the
    // deletion reads, it is waited for; failed just after a statement that
    // deleted, it is waiting again before the deletion next counts what is
    // left, and is neither being sent nor among what that statement deleted.
    const failing = await forward(
      { name: `${prefix}failing`, key: "", data: {}, options: {} },
      3_600,
    );
    await prisma.$executeRawUnsafe(
      `UPDATE pgboss.job SET state = 'active', started_on = now()
       WHERE name = '__pgboss__send-it' AND id = $1::uuid`,
      failing,
    );

    const db = runtime.instance.getDb();
    const executeSql = db.executeSql.bind(db);
    // A while into the deletion rather than at once: a deletion that stopped
    // looking after a fixed wait would have stopped by then.
    const failsAfter = Date.now() + 1_500;
    let failed = false;
    const spy = vi
      .spyOn(db, "executeSql")
      .mockImplementation(async (text: string, values?: unknown[]) => {
        const result = await executeSql(text, values);
        const deleting =
          values?.[0] === "__pgboss__send-it" &&
          values?.[1] === prefix &&
          text.includes("DELETE");
        if (deleting && !failed && Date.now() >= failsAfter) {
          failed = true;
          await prisma.$executeRawUnsafe(
            `UPDATE pgboss.job SET state = 'retry', started_on = NULL
             WHERE name = '__pgboss__send-it' AND id = $1::uuid`,
            failing,
          );
        }
        return result;
      });

    try {
      await runtime.deleteQueuesUnder(prefix);
    } finally {
      spy.mockRestore();
    }

    expect(failed).toBe(true);
    const [left] = await prisma.$queryRawUnsafe<{ count: bigint }[]>(
      `SELECT count(*)::bigint AS count FROM pgboss.job
       WHERE name = '__pgboss__send-it' AND id = $1::uuid`,
      failing,
    );
    expect(left?.count).toBe(0n);
  }, 30_000);

  it("refuses a prefix that would reach other queues", async () => {
    await expect(runtime.deleteQueuesUnder("")).rejects.toThrow(RangeError);
    await expect(runtime.deleteQueuesUnder("/")).rejects.toThrow(RangeError);
    await expect(
      runtime.deleteQueuesUnder(`plugin/${pluginId}`),
    ).rejects.toThrow(RangeError);
  });
});

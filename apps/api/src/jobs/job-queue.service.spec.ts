import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";

import type { Env } from "../config/env";
import { JobQueueService } from "./job-queue.service";

/**
 * The connection a start gives the schedules an earlier release made their
 * queue on, before pg-boss starts. Answers, unless a case says otherwise, that
 * the job schema is not installed, so there is nothing to give.
 */
const pg = vi.hoisted(() => ({
  queries: [] as { text: string; values?: unknown[] }[],
  answer: (_text: string): Promise<unknown> =>
    Promise.resolve({ rows: [{ installed: false }], rowCount: 1 }),
  ended: 0,
}));

vi.mock("pg", () => ({
  Client: class {
    connect(): Promise<void> {
      return Promise.resolve();
    }

    query(text: string, values?: unknown[]): Promise<unknown> {
      pg.queries.push({ text, values });
      return pg.answer(text);
    }

    end(): Promise<void> {
      pg.ended += 1;
      return Promise.resolve();
    }
  },
}));

/**
 * Deleting the queues under a prefix, against pg-boss's own code with its
 * database taken away: what it answers where a step fails, and what the
 * service makes of that.
 *
 * Against a database the same method is proved in job-queue.service.int-spec.ts.
 */

const PREFIX = "plugin/occupancy/";
const QUEUE = `${PREFIX}nightly`;

/** A queue row as pg-boss reads it, as far as the method looks. */
function queueRow(name: string) {
  return { name } as never;
}

interface Built {
  service: JobQueueService;
  getQueues: ReturnType<typeof vi.fn>;
  deleteQueue: ReturnType<typeof vi.spyOn>;
  executeSql: ReturnType<typeof vi.fn>;
}

/**
 * A service whose pg-boss never connects. Its queue cache is never read, as
 * where the read at its start failed, which pg-boss reports and goes on from:
 * so its deleteQueue, left as it is, looks the queue up, fails, and returns.
 */
function build(sending: () => number = () => 0): Built {
  const service = new JobQueueService({
    NODE_ENV: "test",
    DATABASE_URL: "postgresql://openbrf:openbrf@127.0.0.1:1/openbrf",
  } as Env);
  const boss = service.instance;
  vi.spyOn(boss, "start").mockResolvedValue(boss);
  vi.spyOn(boss, "offWork").mockResolvedValue(undefined);
  const getQueues = vi.fn(async () => [queueRow(QUEUE)]);
  vi.spyOn(boss, "getQueues").mockImplementation(getQueues);
  const deleteQueue = vi.spyOn(boss, "deleteQueue");
  const executeSql = vi.fn(async (_text: string) => ({
    rows: [{ sending: sending() }],
  }));
  vi.spyOn(boss, "getDb").mockReturnValue({ executeSql } as never);
  return { service, getQueues, deleteQueue, executeSql };
}

describe("deleting the queues under a prefix", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("refuses where pg-boss answers a deletion it did not make", async () => {
    // Read, found, and handed to deleteQueue, which finds it in no cache and
    // returns as though it had deleted it.
    const built = build();

    await expect(built.service.deleteQueuesUnder(PREFIX)).rejects.toThrow(
      `1 job queue(s) under "${PREFIX}" were not deleted.`,
    );
    expect(built.deleteQueue).toHaveBeenCalledWith(QUEUE);
    await expect(built.deleteQueue.mock.results[0]?.value).resolves.toBe(
      undefined,
    );
    // Nothing of the queue's schedules is touched while the queue stands.
    expect(built.executeSql).not.toHaveBeenCalled();
  });

  it("refuses where the queues cannot be read again", async () => {
    const built = build();
    built.getQueues
      .mockResolvedValueOnce([queueRow(QUEUE)])
      .mockRejectedValueOnce(new Error("connection reset"));

    await expect(built.service.deleteQueuesUnder(PREFIX)).rejects.toThrow(
      "connection reset",
    );
  });

  it("reads past the first page of queues", async () => {
    const built = build();
    const first = Array.from({ length: 1000 }, (_, i) =>
      queueRow(`other/${String(i).padStart(4, "0")}`),
    );
    built.getQueues
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce([queueRow(QUEUE)])
      .mockResolvedValue([]);
    built.deleteQueue.mockResolvedValue(undefined);

    await built.service.deleteQueuesUnder(PREFIX);

    expect(built.deleteQueue).toHaveBeenCalledTimes(1);
    expect(built.deleteQueue).toHaveBeenCalledWith(QUEUE);
    expect(built.getQueues).toHaveBeenNthCalledWith(2, undefined, {
      limit: 1000,
      after: "other/0999",
    });
  });

  it("deletes the occurrences still to be sent, and waits for one being sent", async () => {
    let reads = 0;
    // Being sent at the first two reads, and sent by the third.
    const built = build(() => (++reads <= 2 ? 1 : 0));
    built.getQueues
      .mockResolvedValueOnce([queueRow(QUEUE)])
      .mockResolvedValue([]);
    built.deleteQueue.mockResolvedValue(undefined);

    let done = false;
    const deleting = built.service.deleteQueuesUnder(PREFIX).then(() => {
      done = true;
    });
    await vi.advanceTimersByTimeAsync(150);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(100);
    await deleting;

    // Deleted again at every read, for one that fails and waits again.
    expect(built.executeSql).toHaveBeenCalledTimes(3);
    // pg-boss's own queue, under this prefix and no other.
    expect(built.executeSql.mock.calls[0]?.[1]).toEqual([
      "__pgboss__send-it",
      PREFIX,
    ]);
  });

  it("is done at the first read that finds nothing to be sent", async () => {
    const built = build();
    built.getQueues
      .mockResolvedValueOnce([queueRow(QUEUE)])
      .mockResolvedValue([]);
    built.deleteQueue.mockResolvedValue(undefined);

    await built.service.deleteQueuesUnder(PREFIX);

    expect(built.executeSql).toHaveBeenCalledTimes(1);
  });

  it("refuses where an occurrence is still being sent once the wait is over", async () => {
    const built = build(() => 1);
    built.getQueues
      .mockResolvedValueOnce([queueRow(QUEUE)])
      .mockResolvedValue([]);
    built.deleteQueue.mockResolvedValue(undefined);

    const deleting = built.service.deleteQueuesUnder(PREFIX);
    const refused = expect(deleting).rejects.toThrow(
      `1 cron occurrence(s) for queues under "${PREFIX}" were still being sent`,
    );
    await vi.advanceTimersByTimeAsync(11_000);
    await refused;
  });
});

/**
 * A cron schedule's jobs, held to the queue the schedule was made for.
 *
 * pg-boss's worker and its schedule write are taken away, and the queue's
 * generation is what a stubbed read answers. The same against a database,
 * through a cron pass that outlives a deletion, is in
 * job-queue.service.int-spec.ts.
 */
describe("a cron schedule's jobs", () => {
  const SCHEDULED_FOR = "openbrf:scheduledFor";

  function built(generation: () => string | null) {
    const service = new JobQueueService({
      NODE_ENV: "test",
      DATABASE_URL: "postgresql://openbrf:openbrf@127.0.0.1:1/openbrf",
    } as Env);
    const boss = service.instance;
    vi.spyOn(boss, "start").mockResolvedValue(boss);
    const createQueue = vi
      .spyOn(boss, "createQueue")
      .mockResolvedValue(undefined);
    const schedule = vi.spyOn(boss, "schedule").mockResolvedValue(undefined);
    let worker: ((jobs: { data: unknown }[]) => Promise<unknown>) | undefined;
    vi.spyOn(boss, "work").mockImplementation((async (
      _name: string,
      handler: (jobs: { data: unknown }[]) => Promise<unknown>,
    ) => {
      worker = handler;
      return "worker-1";
    }) as never);
    const executeSql = vi.fn(async (_text: string) => ({
      rows: [{ generation: generation() }].filter(
        (row) => row.generation !== null,
      ),
    }));
    vi.spyOn(boss, "getDb").mockReturnValue({ executeSql } as never);
    return {
      service,
      createQueue,
      schedule,
      executeSql,
      run: async (jobs: { data: unknown }[]) => {
        await worker?.(jobs);
      },
    };
  }

  it("keeps the data with the queue it was scheduled for", async () => {
    const b = built(() => "2026-10-23T03:00:00.000001Z");

    await b.service.schedule(QUEUE, "0 3 * * *", { run: 1 });

    expect(b.schedule).toHaveBeenCalledWith(QUEUE, "0 3 * * *", {
      [SCHEDULED_FOR]: "2026-10-23T03:00:00.000001Z",
      data: { run: 1 },
    });
  });

  it("creates a queue another process deleted again before it schedules", async () => {
    // This process remembers the queue as created; the read finds none.
    let reads = 0;
    const b = built(() => (++reads === 1 ? null : "2026-10-23T03:00:00Z"));

    await b.service.schedule(QUEUE, "0 3 * * *", { run: 1 });

    expect(b.createQueue).toHaveBeenCalledTimes(2);
    expect(b.schedule).toHaveBeenCalledWith(QUEUE, "0 3 * * *", {
      [SCHEDULED_FOR]: "2026-10-23T03:00:00Z",
      data: { run: 1 },
    });
  });

  it("hands the handler a job scheduled for the queue as it is, and no other", async () => {
    const b = built(() => "2026-10-23T03:00:00.000002Z");
    const handler = vi.fn();
    await b.service.work(QUEUE, handler);

    await b.run([
      // From a schedule made for a queue deleted before this one.
      {
        data: {
          [SCHEDULED_FOR]: "2026-10-22T03:00:00.000001Z",
          data: { a: 1 },
        },
      },
      // Sent, not scheduled.
      { data: { b: 2 } },
      {
        data: {
          [SCHEDULED_FOR]: "2026-10-23T03:00:00.000002Z",
          data: { c: 3 },
        },
      },
    ]);

    expect(handler.mock.calls).toEqual([[{ b: 2 }], [{ c: 3 }]]);
    // Once for the batch.
    expect(b.executeSql).toHaveBeenCalledTimes(1);
  });

  it("hands the handler none of a schedule's jobs once its queue is gone", async () => {
    const b = built(() => null);
    const handler = vi.fn();
    await b.service.work(QUEUE, handler);

    await b.run([
      { data: { [SCHEDULED_FOR]: "2026-10-22T03:00:00Z", data: { a: 1 } } },
    ]);

    expect(handler).not.toHaveBeenCalled();
  });

  it("reads the queue only for a batch holding a scheduled job", async () => {
    const b = built(() => "2026-10-23T03:00:00Z");
    const handler = vi.fn();
    await b.service.work(QUEUE, handler);

    await b.run([{ data: { b: 2 } }]);

    expect(handler).toHaveBeenCalledWith({ b: 2 });
    expect(b.executeSql).not.toHaveBeenCalled();
  });
});

/**
 * A start, before pg-boss's own: the schedules an earlier release made, with
 * their data on its own, given the queue each belongs to before a cron pass of
 * this process can read one. pg-boss's start is taken away, and the database
 * is the stubbed connection above. The same against a database, through a
 * cron pass that outlives a deletion, is in job-queue.service.int-spec.ts.
 */
describe("a start", () => {
  function built() {
    const service = new JobQueueService({
      NODE_ENV: "test",
      DATABASE_URL: "postgresql://openbrf:openbrf@127.0.0.1:1/openbrf",
    } as Env);
    const start = vi
      .spyOn(service.instance, "start")
      .mockResolvedValue(service.instance);
    return { service, start };
  }

  const answer = pg.answer;
  let updatedAt: number[];

  beforeEach(() => {
    pg.queries.length = 0;
    pg.ended = 0;
    updatedAt = [];
  });

  afterEach(() => {
    pg.answer = answer;
  });

  /** Answers the job schema as installed, and the update as `updated`. */
  function installed(updated: () => Promise<unknown>) {
    pg.answer = async (text) => {
      if (text.includes("to_regclass")) {
        return { rows: [{ installed: true }], rowCount: 1 };
      }
      updatedAt.push(performance.now());
      return updated();
    };
  }

  it("gives an earlier release's schedules their queue before pg-boss starts", async () => {
    installed(async () => ({ rows: [], rowCount: 2 }));
    const b = built();
    let startedAt = 0;
    b.start.mockImplementation(async () => {
      startedAt = performance.now();
      return b.service.instance;
    });

    await b.service.start();

    const update = pg.queries.find(({ text }) => text.includes("UPDATE"));
    expect(update?.text).toContain("jsonb_build_object");
    expect(update?.values).toEqual(["openbrf:scheduledFor"]);
    expect(updatedAt).toHaveLength(1);
    expect(updatedAt[0]).toBeLessThanOrEqual(startedAt);
    expect(b.start).toHaveBeenCalledTimes(1);
    expect(pg.ended).toBe(1);
  });

  it("starts no cron where the schedules cannot be given their queue", async () => {
    installed(() => Promise.reject(new Error("permission denied")));
    const b = built();

    await expect(b.service.start()).rejects.toThrow("permission denied");

    expect(b.start).not.toHaveBeenCalled();
    expect(pg.ended).toBe(1);
    // The next caller tries again rather than being handed the failure.
    pg.answer = answer;
    await b.service.start();
    expect(b.start).toHaveBeenCalledTimes(1);
  });

  it("has nothing to give where the job schema is not installed yet", async () => {
    const b = built();

    await b.service.start();

    expect(pg.queries.map(({ text }) => text)).toEqual([
      "SELECT to_regclass($1) IS NOT NULL AS installed",
    ]);
    expect(b.start).toHaveBeenCalledTimes(1);
  });
});

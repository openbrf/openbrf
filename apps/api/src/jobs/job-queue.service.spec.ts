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
  const executeSql = vi.fn(async (text: string) =>
    text.trimStart().startsWith("SELECT")
      ? { rows: [{ sending: sending() }] }
      : { rows: [] },
  );
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

    const deleting = built.service.deleteQueuesUnder(PREFIX);
    await vi.advanceTimersByTimeAsync(2_000);
    await deleting;

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
    await vi.advanceTimersByTimeAsync(500);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1_000);
    await deleting;

    const deletes = built.executeSql.mock.calls.filter(([text]) =>
      String(text).trimStart().startsWith("DELETE"),
    );
    // Deleted again at every read, for one that fails and waits again.
    expect(deletes.length).toBeGreaterThanOrEqual(3);
    // pg-boss's own queue, under this prefix and no other.
    expect(deletes[0]?.[1]).toEqual(["__pgboss__send-it", PREFIX]);
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

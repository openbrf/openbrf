import { randomUUID } from "node:crypto";

import { HttpStatus } from "@nestjs/common";
import { PrismaPg } from "@prisma/adapter-pg";
import { Client } from "pg";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import type { PrismaService } from "../database/prisma.service";
import { PrismaClient } from "../generated/prisma/client";
import {
  advisoryLockCount,
  terminateAdvisoryLockHolder,
  waitFor,
} from "../testing/advisory-locks";
import { domainResponse } from "../testing/domain-response";
import {
  loadEnvForIntegrationTests,
  restoreEnvironmentVariable,
} from "../testing/integration-env";
import {
  PACKAGE_BUSY_RETRY_AFTER_SECONDS,
  PACKAGE_LOCK_APPLICATION_NAME,
  PACKAGE_LOCK_LIMITS,
  PackageBusyError,
  PackageLock,
  type PackageLockLimits,
  PackageLockLostError,
} from "./package-lock";

/**
 * The lock itself, against a real database: advisory locks have no meaning
 * against a mock. What matters is who waits for whom, and how many
 * connections the waiting costs.
 *
 * One {@link PackageLock} stands for one process. Two of them over the same
 * database stand for two processes, which share nothing but the database's
 * lock - the way two replicas of the instance would.
 */

const env = loadEnvForIntegrationTests();
let prisma: PrismaClient;

/**
 * Every id this run locks carries the run's suffix. The lock space is the
 * whole cluster's, so two runs locking "same-id" would wait for each other,
 * and the timings below would measure the other run.
 */
const run = randomUUID();
const idOf = (name: string): string => `${name}-${run}`;

type Kind = "plugin" | "theme";

const lockWith = (limits: Partial<PackageLockLimits> = {}): PackageLock =>
  new PackageLock(env, { ...PACKAGE_LOCK_LIMITS, ...limits });

/** The process most tests run in. */
let process1: PackageLock;

const lock = <T>(
  kind: Kind,
  name: string,
  work: (lockLost: AbortSignal) => Promise<T>,
  on: PackageLock = process1,
): Promise<T> => on.run(kind, idOf(name), work);

/** Holders and waiters of this package's key, read from the database. */
const locks = (kind: Kind, name: string, granted: boolean): Promise<bigint> =>
  advisoryLockCount(
    prisma as unknown as PrismaService,
    `package-install:${kind}:${idOf(name)}`,
    granted,
  );

/** The sessions the lock has open on this database, held and waiting alike. */
async function lockSessions(): Promise<bigint> {
  const [row] = await prisma.$queryRaw<{ sessions: bigint }[]>`
    SELECT count(*) AS sessions
    FROM pg_stat_activity
    WHERE datname = current_database()
      AND application_name = ${PACKAGE_LOCK_APPLICATION_NAME}`;
  return row?.sessions ?? 0n;
}

/** A holder that keeps the lock until it is told to let go. */
function hold(
  kind: Kind,
  name: string,
  on: PackageLock = process1,
): { held: Promise<void>; release: () => void } {
  let release: () => void = () => undefined;
  const held = lock(
    kind,
    name,
    () => new Promise<void>((resolve) => (release = resolve)),
    on,
  );
  return { held, release: () => release() };
}

const delay = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

beforeAll(() => {
  // One connection: the lock must never need one of the application's.
  prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: env.DATABASE_URL, max: 1 }),
  });
});

beforeEach(async () => {
  process1 = lockWith();
  // A closed session ends on the server's own time; the counts below would
  // otherwise include the last test's.
  await waitFor(async () => (await lockSessions()) === 0n);
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("PackageLock", () => {
  it("runs two holders of one package one after the other", async () => {
    const trace: string[] = [];
    const traced = (label: string): Promise<void> =>
      lock("plugin", "same-id", async () => {
        trace.push(`${label} in`);
        await delay(150);
        trace.push(`${label} out`);
      });

    await Promise.all([traced("a"), traced("b")]);

    // Whichever got the lock first finished before the other began.
    expect(trace[0]?.endsWith("in")).toBe(true);
    expect(trace[1]).toBe(`${trace[0]?.split(" ")[0]} out`);
    expect(trace).toHaveLength(4);
  });

  it("runs two processes' holders of one package one after the other", async () => {
    const process2 = lockWith();
    const first = hold("theme", "two-process-id");
    await waitFor(
      async () => (await locks("theme", "two-process-id", true)) === 1n,
    );

    let entered = false;
    const second = lock(
      "theme",
      "two-process-id",
      async () => {
        entered = true;
      },
      process2,
    );
    // The other process waits in the database, which is the only thing the
    // two share.
    await waitFor(
      async () => (await locks("theme", "two-process-id", false)) === 1n,
    );
    expect(entered).toBe(false);

    first.release();
    await Promise.all([first.held, second]);
    expect(entered).toBe(true);
  });

  it("does not make a different id wait", async () => {
    const one = hold("plugin", "id-one");
    await waitFor(async () => (await locks("plugin", "id-one", true)) === 1n);

    const started = Date.now();
    await lock("plugin", "id-two", async () => undefined);
    expect(Date.now() - started).toBeLessThan(1000);

    one.release();
    await one.held;
  });

  it("does not make a theme wait for a plugin of the same id", async () => {
    const plugin = hold("plugin", "shared-id");
    await waitFor(
      async () => (await locks("plugin", "shared-id", true)) === 1n,
    );

    await lock("theme", "shared-id", async () => undefined);

    plugin.release();
    await plugin.held;
  });

  it("is released when the work fails", async () => {
    await expect(
      lock("theme", "failing-id", async () => {
        throw new Error("refused");
      }),
    ).rejects.toThrow("refused");

    await lock("theme", "failing-id", async () => undefined);
  });

  /*
   * Waiters in the process queue on a promise, not on a connection. On the
   * application's pool, enough of them would leave the holder no connection
   * for its own work; on connections of their own, enough of them would leave
   * the database none to give anybody.
   */
  it("queues a second operation on the package without opening a connection for it", async () => {
    const waiters: Promise<void>[] = [];
    let queried: unknown;
    const holder = lock("plugin", "busy-id", async () => {
      for (let index = 0; index < 3; index += 1) {
        waiters.push(lock("plugin", "busy-id", async () => undefined));
      }
      await delay(100);
      expect(await lockSessions()).toBe(1n);
      expect(await locks("plugin", "busy-id", false)).toBe(0n);
      queried = await prisma.$queryRaw`SELECT 1 AS one`;
    });

    await holder;
    await Promise.all(waiters);
    expect(queried).toEqual([{ one: 1 }]);
  });

  /*
   * The cap the security review asked for: (cap + k) operations on one id
   * while a holder blocks. The holder and cap - 1 waiters are admitted, the
   * rest are refused at once, and the whole lot costs the database one
   * session.
   */
  it("refuses operations past its limit at once, and opens one session for the rest", async () => {
    const cap = 3;
    const capped = lockWith({ maxOperations: cap });
    const holder = hold("theme", "capped-id", capped);
    await waitFor(async () => (await locks("theme", "capped-id", true)) === 1n);

    const started = Date.now();
    const attempts = Array.from({ length: cap + 2 }, () =>
      lock("theme", "capped-id", async () => undefined, capped).then(
        () => "ran",
        (error: unknown) => error,
      ),
    );
    const refused = (
      await Promise.race([
        Promise.all(attempts.slice(cap - 1)),
        delay(5_000).then(() => []),
      ])
    ).filter((outcome) => outcome instanceof PackageBusyError);
    expect(refused).toHaveLength(3);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(await lockSessions()).toBe(1n);

    holder.release();
    await holder.held;
    expect(await Promise.all(attempts.slice(0, cap - 1))).toEqual([
      "ran",
      "ran",
    ]);
  });

  it("holds no more sessions than its limit across different ids", async () => {
    const cap = 2;
    const capped = lockWith({ maxOperations: cap });
    const holders = [
      hold("plugin", "cap-a", capped),
      hold("plugin", "cap-b", capped),
    ];
    await waitFor(async () => (await lockSessions()) === 2n);

    await expect(
      lock("plugin", "cap-c", async () => undefined, capped),
    ).rejects.toBeInstanceOf(PackageBusyError);
    expect(await lockSessions()).toBe(2n);

    for (const holder of holders) {
      holder.release();
    }
    await Promise.all(holders.map((holder) => holder.held));
    // A refusal gives back nothing it did not take: the limit is whole again.
    await lock("plugin", "cap-c", async () => undefined, capped);
  });

  /*
   * The wait is bounded, the hold is not. A waiter that gives up must not
   * take the lock away from work that is still running, nor the place in the
   * queue from whoever is behind it.
   */
  it("gives up waiting in the process without disturbing the holder or the queue", async () => {
    const quick = lockWith({ waitMs: 200 });
    const slow = hold("theme", "slow-id", quick);
    await waitFor(async () => (await locks("theme", "slow-id", true)) === 1n);

    await expect(
      lock("theme", "slow-id", async () => undefined, quick),
    ).rejects.toBeInstanceOf(PackageBusyError);
    expect(await locks("theme", "slow-id", true)).toBe(1n);

    slow.release();
    await slow.held;
    // The one that gave up left nothing behind for the next one to wait on.
    await lock("theme", "slow-id", async () => undefined, quick);
  });

  it("gives up waiting for another process without releasing its lock", async () => {
    const slow = hold("theme", "slow-other-id");
    await waitFor(
      async () => (await locks("theme", "slow-other-id", true)) === 1n,
    );

    await expect(
      lock(
        "theme",
        "slow-other-id",
        async () => undefined,
        lockWith({ waitMs: 200 }),
      ),
    ).rejects.toBeInstanceOf(PackageBusyError);
    expect(await locks("theme", "slow-other-id", true)).toBe(1n);

    slow.release();
    await slow.held;
    // The server ends a closed session on its own time, the lock with it.
    await waitFor(
      async () => (await locks("theme", "slow-other-id", true)) === 0n,
    );
  });

  /*
   * The review's lost-session case: only the lock's backend ends, the
   * database stays up, and Postgres hands the lock to the next asker while the
   * work that held it is still running.
   */
  it("stops the work at its next write once the session is lost, and keeps this process out until then", async () => {
    let resume: () => void = () => undefined;
    const paused = new Promise<void>((resolve) => (resume = resolve));
    let signal: AbortSignal | undefined;
    const written: string[] = [];

    const first = lock("theme", "lost-id", async (lockLost) => {
      signal = lockLost;
      await paused;
      lockLost.throwIfAborted();
      written.push("first");
    });
    await waitFor(async () => (await locks("theme", "lost-id", true)) === 1n);

    expect(
      await terminateAdvisoryLockHolder(
        prisma as unknown as PrismaService,
        `package-install:theme:${idOf("lost-id")}`,
      ),
    ).toBe(1);
    await waitFor(async () => signal?.aborted === true);
    expect(signal?.reason).toBeInstanceOf(PackageLockLostError);
    await waitFor(async () => (await locks("theme", "lost-id", true)) === 0n);

    // Another process gets the database's lock: that half is gone.
    await lock("theme", "lost-id", async () => undefined, lockWith());

    // This process does not, until the work that lost it has stopped.
    let secondEntered = false;
    const second = lock("theme", "lost-id", async () => {
      secondEntered = true;
    });
    await delay(200);
    expect(secondEntered).toBe(false);

    resume();
    await expect(first).rejects.toBeInstanceOf(PackageLockLostError);
    await second;
    expect(secondEntered).toBe(true);
    expect(written).toEqual([]);
  });

  /*
   * A client-side authentication failure - here SCRAM with no password to
   * answer it - rejects the connect and leaves the socket open, and only
   * ending the client closes it.
   */
  it("closes the connection when connecting fails", async () => {
    // Calls through; what it keeps is each call's client.
    const connect = vi.spyOn(Client.prototype, "connect");

    const url = new URL(env.DATABASE_URL);
    url.password = "";
    const savedPassword = process.env.PGPASSWORD;
    delete process.env.PGPASSWORD;
    try {
      const unauthenticated = new PackageLock(
        {
          ...env,
          DATABASE_URL: url.toString(),
          DATABASE_URL_RUNTIME: undefined,
        },
        PACKAGE_LOCK_LIMITS,
      );
      await expect(
        unauthenticated.run(
          "plugin",
          idOf("no-password"),
          async () => undefined,
        ),
      ).rejects.toThrow(/password/u);
    } finally {
      restoreEnvironmentVariable("PGPASSWORD", savedPassword);
    }

    expect(connect.mock.contexts).toHaveLength(1);
    const stream = (
      connect.mock.contexts[0] as unknown as {
        connection: { stream: { destroyed: boolean } };
      }
    ).connection.stream;
    await waitFor(async () => stream.destroyed, 5_000);
  });

  it("answers a wait that ran out as a retryable refusal with its own reason", async () => {
    const slow = hold("plugin", "answered-id");
    await waitFor(
      async () => (await locks("plugin", "answered-id", true)) === 1n,
    );

    const error = await lock(
      "plugin",
      "answered-id",
      async () => undefined,
      lockWith({ waitMs: 25 }),
    ).catch((caught: unknown) => caught);
    slow.release();
    await slow.held;

    expect(error).toBeInstanceOf(PackageBusyError);
    const { status, headers, body } = domainResponse(error as PackageBusyError);
    expect(status).toBe(HttpStatus.TOO_MANY_REQUESTS);
    expect(headers["retry-after"]).toBe(
      String(PACKAGE_BUSY_RETRY_AFTER_SECONDS),
    );
    expect(body["reason"]).toBe("package-busy");
  });
});

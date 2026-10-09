import { randomUUID } from "node:crypto";

import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { PrismaService } from "../database/prisma.service";
import { PrismaClient } from "../generated/prisma/client";
import { advisoryLockCount, waitFor } from "../testing/advisory-locks";
import { loadEnvForIntegrationTests } from "../testing/integration-env";
import { PackageLockTimeoutError, withPackageLock } from "./package-lock";

/**
 * The lock itself, against a real database: advisory locks have no meaning
 * against a mock. What matters is who waits for whom.
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

const lock = <T>(
  kind: "plugin" | "theme",
  name: string,
  work: () => Promise<T>,
  waitMs?: number,
): Promise<T> =>
  withPackageLock(env.DATABASE_URL, kind, idOf(name), work, waitMs);

/** Holders and waiters of this package's key, read from the database. */
const locks = (
  kind: "plugin" | "theme",
  name: string,
  granted: boolean,
): Promise<bigint> =>
  advisoryLockCount(
    prisma as unknown as PrismaService,
    `package-install:${kind}:${idOf(name)}`,
    granted,
  );

/** A holder that keeps the lock until it is told to let go. */
function hold(
  kind: "plugin" | "theme",
  name: string,
): { held: Promise<void>; release: () => void } {
  let release: () => void = () => undefined;
  const held = lock(
    kind,
    name,
    () => new Promise<void>((resolve) => (release = resolve)),
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

afterAll(async () => {
  await prisma.$disconnect();
});

describe("withPackageLock", () => {
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
   * Waiters queue on connections of their own. On the application's pool,
   * enough of them would leave the holder no connection for its own work,
   * and everybody would sit out the wait with no deadlock to show for it.
   */
  it("leaves the application's pool to the holder while others wait", async () => {
    const waiters: Promise<void>[] = [];
    let queried: unknown;
    const holder = lock("plugin", "busy-id", async () => {
      for (let index = 0; index < 3; index += 1) {
        waiters.push(lock("plugin", "busy-id", async () => undefined));
      }
      await waitFor(
        async () => (await locks("plugin", "busy-id", false)) === 3n,
      );
      queried = await prisma.$queryRaw`SELECT 1 AS one`;
    });

    await holder;
    await Promise.all(waiters);
    expect(queried).toEqual([{ one: 1 }]);
  });

  /*
   * The wait is bounded, the hold is not. A waiter that gives up must not
   * take the lock away from work that is still running.
   */
  it("gives up waiting without releasing the holder's lock", async () => {
    const slow = hold("theme", "slow-id");
    await waitFor(async () => (await locks("theme", "slow-id", true)) === 1n);

    await expect(
      lock("theme", "slow-id", async () => undefined, 200),
    ).rejects.toBeInstanceOf(PackageLockTimeoutError);
    expect(await locks("theme", "slow-id", true)).toBe(1n);

    slow.release();
    await slow.held;
    // The server ends a closed session on its own time, the lock with it.
    await waitFor(async () => (await locks("theme", "slow-id", true)) === 0n);
  });
});

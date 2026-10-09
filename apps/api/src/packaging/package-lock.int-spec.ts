import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PrismaClient } from "../generated/prisma/client";
import { loadEnvForIntegrationTests } from "../testing/integration-env";
import { withPackageLock } from "./package-lock";

/**
 * The lock itself, against a real database: advisory locks have no meaning
 * against a mock. What matters is who waits for whom.
 */

const env = loadEnvForIntegrationTests();
let prisma: PrismaClient;

const delay = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

beforeAll(() => {
  prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: env.DATABASE_URL, max: 6 }),
  });
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("withPackageLock", () => {
  it("runs two holders of one package one after the other", async () => {
    const trace: string[] = [];
    const hold = (label: string): Promise<void> =>
      withPackageLock(prisma, "plugin", "same-id", async () => {
        trace.push(`${label} in`);
        await delay(150);
        trace.push(`${label} out`);
      });

    await Promise.all([hold("a"), hold("b")]);

    // Whichever got the lock first finished before the other began.
    expect(trace[0]?.endsWith("in")).toBe(true);
    expect(trace[1]).toBe(`${trace[0]?.split(" ")[0]} out`);
    expect(trace).toHaveLength(4);
  });

  it("does not make a different id wait", async () => {
    let release: () => void = () => undefined;
    const held = withPackageLock(
      prisma,
      "plugin",
      "id-one",
      () => new Promise<void>((resolve) => (release = resolve)),
    );
    await delay(100);

    const started = Date.now();
    await withPackageLock(prisma, "plugin", "id-two", async () => undefined);
    expect(Date.now() - started).toBeLessThan(1000);

    release();
    await held;
  });

  it("does not make a theme wait for a plugin of the same id", async () => {
    let release: () => void = () => undefined;
    const held = withPackageLock(
      prisma,
      "plugin",
      "shared-id",
      () => new Promise<void>((resolve) => (release = resolve)),
    );
    await delay(100);

    await withPackageLock(prisma, "theme", "shared-id", async () => undefined);

    release();
    await held;
  });

  it("is released when the work fails", async () => {
    await expect(
      withPackageLock(prisma, "theme", "failing-id", async () => {
        throw new Error("refused");
      }),
    ).rejects.toThrow("refused");

    await withPackageLock(prisma, "theme", "failing-id", async () => undefined);
  });
});

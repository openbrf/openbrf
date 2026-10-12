import {
  FastifyAdapter,
  type NestFastifyApplication,
} from "@nestjs/platform-fastify";
import { Test } from "@nestjs/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AppModule } from "../app.module";
import { PrismaService } from "../database/prisma.service";
import { advisoryLockCount, waitFor } from "../testing/advisory-locks";
import {
  loadEnvForIntegrationTests,
  runSuffix,
} from "../testing/integration-env";
import { SettingsService } from "./settings.service";

/**
 * The retention policy's audit entry against a real database.
 *
 * The entry names the value a change replaced, and that value is read before
 * the write. What only a database can show is that two changes arriving
 * together are ordered, so the second one names what the first one wrote: the
 * unit tests run against a fake that has no concurrent transaction to race.
 */

loadEnvForIntegrationTests();

let app: NestFastifyApplication;
let prisma: PrismaService;
let settings: SettingsService;

const suffix = runSuffix();
const actorPersonId = `retention-admin-${suffix}`;

/** What the association kept before this suite, put back afterwards. */
let originalDays: number;

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();

  app = moduleRef.createNestApplication<NestFastifyApplication>(
    new FastifyAdapter(),
  );
  await app.init();
  await app.getHttpAdapter().getInstance().ready();

  prisma = app.get(PrismaService);
  settings = app.get(SettingsService);

  const association = await prisma.association.upsert({
    where: { id: 1 },
    create: {
      id: 1,
      name: "Brf Eksemplet",
      organizationNumber: "769600-0000",
      setupCompletedAt: new Date(),
    },
    update: {},
    select: { retentionDaysAfterMoveOut: true },
  });
  originalDays = association.retentionDaysAfterMoveOut;
}, 180_000);

afterAll(async () => {
  try {
    if (prisma !== undefined) {
      // Other suites in this worker read the policy; the entries this one
      // wrote stay, as the log is append-only.
      await prisma.association.update({
        where: { id: 1 },
        data: { retentionDaysAfterMoveOut: originalDays },
      });
    }
  } finally {
    await app?.close();
  }
});

describe("changing the retention policy", () => {
  it("names the value it replaced when another change came first", async () => {
    /*
     * Another change holds the policy's key and has set 730 days without
     * committing. The change to 30 must wait for it and then read 730: without
     * the wait it reads the old value, and the log says forever that 30
     * replaced a period that was no longer in force. The key is spelled out so
     * a writer that changed it fails this instead of passing.
     */
    const key = "association-retention";
    const startDays = originalDays === 365 ? 366 : 365;
    await prisma.association.update({
      where: { id: 1 },
      data: { retentionDaysAfterMoveOut: startDays },
    });

    let releaseHolder: (() => void) | undefined;
    const holderDone = new Promise<void>((resolve) => {
      releaseHolder = resolve;
    });
    const holder = prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${key}))`;
        await tx.association.update({
          where: { id: 1 },
          data: { retentionDaysAfterMoveOut: 730 },
        });
        await holderDone;
      },
      { timeout: 60_000, maxWait: 20_000 },
    );

    let saving: Promise<{ daysAfterMoveOut: number }> | undefined;
    try {
      await waitFor(
        async () => (await advisoryLockCount(prisma, key, true)) > 0n,
      );

      saving = settings.updateRetention({
        actorPersonId,
        daysAfterMoveOut: 30,
      });
      await waitFor(
        async () => (await advisoryLockCount(prisma, key, false)) > 0n,
      );

      releaseHolder?.();
      await holder;
      expect(await saving).toEqual({ daysAfterMoveOut: 30 });
    } finally {
      releaseHolder?.();
      await holder.catch(() => undefined);
      await saving?.catch(() => undefined);
    }

    const entries = await prisma.auditLogEntry.findMany({
      where: { action: "ASSOCIATION_RETENTION_RECORDED", actorPersonId },
      select: { context: true },
    });
    expect(entries).toEqual([
      { context: { daysAfterMoveOutFrom: 730, daysAfterMoveOutTo: 30 } },
    ]);
  }, 60_000);
});

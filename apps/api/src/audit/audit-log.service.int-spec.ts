import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PrismaClient } from "../generated/prisma/client";
import { AuditLogService } from "./audit-log.service";
import { loadEnvForIntegrationTests } from "../testing/integration-env";
import type { PrismaService } from "../database/prisma.service";

/**
 * The audit log's value rests on two properties that only a real database can
 * demonstrate: an entry commits together with the access it records, and no
 * entry can be rewritten afterwards.
 */

const env = loadEnvForIntegrationTests();

let prisma: PrismaClient;
let service: AuditLogService;

const suffix = process.hrtime.bigint().toString(36);
const ACTOR_ID = `audit-actor-${suffix}`;
const TARGET_ID = `audit-target-${suffix}`;

beforeAll(async () => {
  prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: env.DATABASE_URL }),
  });
  // The service only needs the client surface, which PrismaService extends.
  service = new AuditLogService(prisma as unknown as PrismaService);

  await prisma.person.createMany({
    data: [
      { id: ACTOR_ID, firstName: "Anna", lastName: "Lindqvist" },
      {
        id: TARGET_ID,
        firstName: "Sara",
        lastName: "Berg",
        protectedPersonalData: true,
      },
    ],
  });
});

afterAll(async () => {
  await prisma.$executeRawUnsafe(
    'ALTER TABLE "audit_log_entry" DISABLE TRIGGER "audit_log_entry_append_only"',
  );
  await prisma.auditLogEntry.deleteMany({
    where: { actorPersonId: { in: [ACTOR_ID] } },
  });
  await prisma.$executeRawUnsafe(
    'ALTER TABLE "audit_log_entry" ENABLE TRIGGER "audit_log_entry_append_only"',
  );
  await prisma.person.deleteMany({
    where: { id: { in: [ACTOR_ID, TARGET_ID] } },
  });
  await prisma.$disconnect();
});

describe("AuditLogService", () => {
  it("records a reveal naming the fields that were seen", async () => {
    await service.recordProtectedDataReveal({
      actorPersonId: ACTOR_ID,
      targetPersonId: TARGET_ID,
      fields: ["phone", "email"],
      reason: "Contacting the resident about a water leak",
    });

    const entry = await prisma.auditLogEntry.findFirstOrThrow({
      where: { actorPersonId: ACTOR_ID, action: "PROTECTED_DATA_REVEALED" },
      orderBy: { createdAt: "desc" },
    });

    expect(entry.targetPersonId).toBe(TARGET_ID);
    expect(entry.context).toMatchObject({
      fields: ["phone", "email"],
      reason: "Contacting the resident about a water leak",
    });
  });

  it("commits the log entry together with the read it records", async () => {
    const person = await service.withAuditedRead(
      {
        action: "MEMBER_REGISTER_EXTRACT_GENERATED",
        actorPersonId: ACTOR_ID,
      },
      async (tx) => tx.person.findUniqueOrThrow({ where: { id: TARGET_ID } }),
    );

    expect(person.id).toBe(TARGET_ID);
    await expect(
      prisma.auditLogEntry.count({
        where: {
          actorPersonId: ACTOR_ID,
          action: "MEMBER_REGISTER_EXTRACT_GENERATED",
        },
      }),
    ).resolves.toBe(1);
  });

  it("writes no log entry when the audited read fails", async () => {
    const before = await prisma.auditLogEntry.count({
      where: { actorPersonId: ACTOR_ID, action: "DATA_EXPORTED" },
    });

    await expect(
      service.withAuditedRead(
        { action: "DATA_EXPORTED", actorPersonId: ACTOR_ID },
        async () => {
          throw new Error("export failed halfway through");
        },
      ),
    ).rejects.toThrow("export failed halfway through");

    // A log claiming an export that never completed would be worse than no
    // log at all, so the rollback has to take the entry with it.
    await expect(
      prisma.auditLogEntry.count({
        where: { actorPersonId: ACTOR_ID, action: "DATA_EXPORTED" },
      }),
    ).resolves.toBe(before);
  });

  it("exposes no way to amend history, and the database refuses it anyway", async () => {
    const entry = await prisma.auditLogEntry.findFirstOrThrow({
      where: { actorPersonId: ACTOR_ID },
    });

    expect("amend" in service).toBe(false);
    await expect(
      prisma.auditLogEntry.update({
        where: { id: entry.id },
        data: { context: { fields: [] } },
      }),
    ).rejects.toThrow(/OPENBRF_STATUTORY_ARCHIVE/);
  });
});

import { PrismaPg } from "@prisma/adapter-pg";
import {
  type PluginRecipient,
  PluginRecipientError,
} from "@openbrf/plugin-sdk";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { AuditLogService } from "../audit/audit-log.service";
import type { PrismaService } from "../database/prisma.service";
import { PrismaClient } from "../generated/prisma/client";
import type { PinnedRequest } from "../network/pinned-request";
import { loadEnvForIntegrationTests } from "../testing/integration-env";
import { PluginRecipientsService } from "./plugin-recipients.service";

/**
 * A disclosure through `host.recipients.fetch`, against a real database
 * (ADR 0037).
 *
 * What only a database shows: the entries before the send are committed by
 * the time the request leaves, the outcome lands beside them in the
 * append-only log, the two new audit actions exist in the enum the migration
 * extends, and the persons the host refuses are refused by the columns that
 * hold the protection and the restriction. The network is a double that reads
 * the log at the moment it is asked to send.
 */

const env = loadEnvForIntegrationTests();

const suffix = process.hrtime.bigint().toString(36);
const PLUGIN = `recipients-${suffix}`;
const RESIDENT = `recipients-resident-${suffix}`;
const NEIGHBOUR = `recipients-neighbour-${suffix}`;
const PROTECTED = `recipients-protected-${suffix}`;
const RESTRICTED = `recipients-restricted-${suffix}`;
const PERSONS = [RESIDENT, NEIGHBOUR, PROTECTED, RESTRICTED];

const PROVIDER: PluginRecipient = {
  id: "model-provider",
  origin: "https://api.example.com",
  purpose: { sv: "Språkmodellen", en: "The language model" },
  personalData: ["name", "freeText"],
};

let prisma: PrismaClient;
let service: PluginRecipientsService;
/** The disclosure entries committed when the network was asked to send. */
let committedAtSend: number[];

beforeAll(async () => {
  prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: env.DATABASE_URL }),
  });
  committedAtSend = [];
  service = new PluginRecipientsService(
    prisma as unknown as PrismaService,
    new AuditLogService(prisma as unknown as PrismaService),
    { ...env, OPENBRF_ALLOW_PRIVATE_HOSTS: false },
    {
      resolve: async () => [{ address: "93.184.215.14", family: 4 }],
      send: async (_request: PinnedRequest) => {
        committedAtSend.push(
          await prisma.auditLogEntry.count({
            where: { targetId: PLUGIN, action: "PLUGIN_DISCLOSURE_STARTED" },
          }),
        );
        return { status: 200, headers: {}, body: Buffer.from("{}") };
      },
    },
  );

  await prisma.person.createMany({
    data: [
      { id: RESIDENT, firstName: "Anna", lastName: "Lindqvist" },
      { id: NEIGHBOUR, firstName: "Erik", lastName: "Holm" },
      {
        id: PROTECTED,
        firstName: "Sara",
        lastName: "Berg",
        protectedPersonalData: true,
      },
      {
        id: RESTRICTED,
        firstName: "Olof",
        lastName: "Ek",
        processingRestrictedAt: new Date(),
      },
    ],
  });
});

afterAll(async () => {
  // The entries stay: the audit log is append-only, and their target is a
  // plugin id no other run uses.
  await prisma.person.deleteMany({ where: { id: { in: PERSONS } } });
  await prisma.$disconnect();
});

describe("a disclosure to a declared recipient", () => {
  it("commits an entry per person before the send and the outcome after", async () => {
    await service.fetch(PLUGIN, [PROVIDER], "model-provider", "/v1/messages", {
      method: "POST",
      body: '{"text":"..."}',
      disclosure: {
        personalData: ["name"],
        subjects: [RESIDENT, NEIGHBOUR],
      },
    });

    // Both were in the log, committed, when the request left.
    expect(committedAtSend).toEqual([2]);

    const entries = await prisma.auditLogEntry.findMany({
      where: { targetId: PLUGIN },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
    expect(entries).toHaveLength(4);
    expect(
      entries.map((entry) => [entry.action, entry.targetPersonId]),
    ).toEqual(
      expect.arrayContaining([
        ["PLUGIN_DISCLOSURE_STARTED", RESIDENT],
        ["PLUGIN_DISCLOSURE_STARTED", NEIGHBOUR],
        ["PLUGIN_DISCLOSURE_FINISHED", RESIDENT],
        ["PLUGIN_DISCLOSURE_FINISHED", NEIGHBOUR],
      ]),
    );
    for (const entry of entries) {
      expect(entry.channel).toBe("PLUGIN");
      expect(entry.pluginId).toBe(PLUGIN);
      expect(entry.actorPersonId).toBeNull();
    }
    expect(
      entries.find(
        (entry) =>
          entry.action === "PLUGIN_DISCLOSURE_FINISHED" &&
          entry.targetPersonId === RESIDENT,
      )?.context,
    ).toMatchObject({ outcome: "answered", status: 200 });
  });

  it.each([
    ["a person with protected personal data", PROTECTED],
    ["a person under a restriction of processing", RESTRICTED],
    ["an id the register does not hold", `recipients-nobody-${suffix}`],
  ])("refuses %s and writes nothing", async (_label, subject) => {
    const before = await prisma.auditLogEntry.count({
      where: { targetId: PLUGIN },
    });

    await expect(
      service.fetch(PLUGIN, [PROVIDER], "model-provider", "/v1/messages", {
        method: "POST",
        body: "{}",
        disclosure: { personalData: ["name"], subjects: [RESIDENT, subject] },
      }),
    ).rejects.toBeInstanceOf(PluginRecipientError);

    expect(
      await prisma.auditLogEntry.count({ where: { targetId: PLUGIN } }),
    ).toBe(before);
  });
});

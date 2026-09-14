import { describe, expect, it, vi } from "vitest";

import type { PrismaService } from "../database/prisma.service";
import { AuditLogService } from "./audit-log.service";

/**
 * What every entry says about the way the act reached the records, and about
 * the connected app that made it.
 *
 * The channel is required rather than defaulted, and the acting app is written
 * by the service rather than by the call site: both are properties of the
 * writer, so that an entry cannot be recorded correctly in every respect except
 * the one this change exists for.
 */

function build() {
  const auditLogEntry = { create: vi.fn().mockResolvedValue({}) };
  const prisma = { auditLogEntry };
  return {
    service: new AuditLogService(prisma as unknown as PrismaService),
    auditLogEntry,
  };
}

/** The row the service asked Prisma to insert. */
function written(auditLogEntry: { create: ReturnType<typeof vi.fn> }): {
  channel: string;
  actorPersonId: string | null;
  context?: Record<string, unknown>;
} {
  const [first] = auditLogEntry.create.mock.calls;
  if (first === undefined) {
    throw new Error("Nothing was written.");
  }
  return (first[0] as { data: never }).data;
}

describe("recording the channel", () => {
  it("writes the channel it was given", async () => {
    const { service, auditLogEntry } = build();

    await service.record({
      action: "NEWS_PUBLISHED",
      channel: "MCP",
      actorPersonId: "person-1",
    });

    expect(written(auditLogEntry).channel).toBe("MCP");
  });

  it("refuses an entry that names no channel", async () => {
    const { service } = build();

    await service.record(
      // @ts-expect-error - the channel is required, so that a new call site
      // decides rather than inherits. The directive is the assertion: it fails
      // the build if this ever compiles.
      { action: "NEWS_PUBLISHED", actorPersonId: "person-1" },
    );
  });

  it("takes SYSTEM for an act with no person behind it", async () => {
    const { service, auditLogEntry } = build();

    await service.record({ action: "SERVICE_DATA_PURGED", channel: "SYSTEM" });

    const entry = written(auditLogEntry);
    expect(entry.channel).toBe("SYSTEM");
    // The value replaces the inference that an entry with no actor was the
    // system's, which held only while every other writer had one.
    expect(entry.actorPersonId).toBeNull();
  });
});

describe("recording which connected app acted", () => {
  it("writes the app into the context under a key of the log's own", async () => {
    const { service, auditLogEntry } = build();

    await service.record({
      action: "NEWS_PUBLISHED",
      channel: "MCP",
      actorPersonId: "person-1",
      clientId: "client-1",
      clientHost: "claude.ai",
      context: { slug: "arsstamma" },
    });

    expect(written(auditLogEntry).context).toEqual({
      slug: "arsstamma",
      client: { id: "client-1", host: "claude.ai" },
    });
  });

  it("leaves the context alone when no app acted", async () => {
    const { service, auditLogEntry } = build();

    await service.record({
      action: "NEWS_PUBLISHED",
      channel: "WEB",
      actorPersonId: "person-1",
      context: { slug: "arsstamma" },
    });

    expect(written(auditLogEntry).context).toEqual({ slug: "arsstamma" });
  });

  it("records an app whose host is unknown", async () => {
    // A hand-registered client publishes no description of itself, so there is
    // no host to record. Which client acted is the load-bearing half.
    const { service, auditLogEntry } = build();

    await service.record({
      action: "NEWS_PUBLISHED",
      channel: "MCP",
      actorPersonId: "person-1",
      clientId: "client-1",
    });

    expect(written(auditLogEntry).context).toEqual({
      client: { id: "client-1", host: null },
    });
  });

  it("never lets a caller's own key stand in for the acting app", async () => {
    // The key is reserved. An entry saying which app acted has to have got
    // that from the token the request presented, not from the writer's prose.
    const { service, auditLogEntry } = build();

    await service.record({
      action: "NEWS_PUBLISHED",
      channel: "MCP",
      actorPersonId: "person-1",
      clientId: "client-1",
      clientHost: "claude.ai",
      context: { client: { id: "somebody-else" } },
    });

    expect(written(auditLogEntry).context).toEqual({
      client: { id: "client-1", host: "claude.ai" },
    });
  });

  it("carries the channel through a protected data reveal", async () => {
    // The one audit write that builds its entry itself, and so the one that
    // would otherwise have inherited a channel nobody chose.
    const { service, auditLogEntry } = build();

    await service.recordProtectedDataReveal({
      actorPersonId: "person-1",
      targetPersonId: "person-2",
      channel: "WEB",
      fields: ["phone"],
    });

    expect(written(auditLogEntry).channel).toBe("WEB");
  });
});

import { describe, expect, it, vi } from "vite-plus/test";

import type { PrismaService } from "../database/prisma.service";
import { runForSupportSession } from "./acting-support-session";
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

function build(clientName: string | null = "Claude") {
  const auditLogEntry = { create: vi.fn().mockResolvedValue({}) };
  const oauthClient = {
    findUnique: vi.fn().mockResolvedValue({ name: clientName }),
  };
  const prisma = { auditLogEntry, oauthClient };
  return {
    service: new AuditLogService(prisma as unknown as PrismaService),
    auditLogEntry,
    oauthClient,
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
      client: { id: "client-1", name: "Claude", host: "claude.ai" },
    });
  });

  it("names the app by its own row, not by anything the caller passed", async () => {
    const { service, auditLogEntry, oauthClient } = build("  Notes\u0000app  ");

    await service.record({
      action: "NEWS_PUBLISHED",
      channel: "MCP",
      actorPersonId: "person-1",
      clientId: "client-1",
      context: { client: { name: "somebody else" } },
    });

    expect(oauthClient.findUnique).toHaveBeenCalledWith({
      where: { clientId: "client-1" },
      select: { name: true },
    });
    expect(written(auditLogEntry).context).toEqual({
      client: { id: "client-1", name: "Notes app", host: null },
    });
  });

  it("bounds a name the client chose for itself", async () => {
    const { service, auditLogEntry } = build("x".repeat(500));

    await service.record({
      action: "NEWS_PUBLISHED",
      channel: "MCP",
      actorPersonId: "person-1",
      clientId: "client-1",
    });

    const { client } = written(auditLogEntry).context as {
      client: { name: string };
    };
    expect(client.name).toHaveLength(100);
  });

  it("records a null name for an app whose row has none", async () => {
    const { service, auditLogEntry } = build(null);

    await service.record({
      action: "NEWS_PUBLISHED",
      channel: "MCP",
      actorPersonId: "person-1",
      clientId: "client-1",
    });

    expect(written(auditLogEntry).context).toEqual({
      client: { id: "client-1", name: null, host: null },
    });
  });

  it("leaves the context alone when no app acted", async () => {
    const { service, auditLogEntry, oauthClient } = build();

    await service.record({
      action: "NEWS_PUBLISHED",
      channel: "WEB",
      actorPersonId: "person-1",
      context: { slug: "arsstamma" },
    });

    expect(written(auditLogEntry).context).toEqual({ slug: "arsstamma" });
    expect(oauthClient.findUnique).not.toHaveBeenCalled();
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
      client: { id: "client-1", name: "Claude", host: null },
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
      client: { id: "client-1", name: "Claude", host: "claude.ai" },
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

describe("an entry written while a support session's request is served", () => {
  it("is on SUPPORT whatever channel the call site passed, and names the session", async () => {
    const { service, auditLogEntry } = build();

    // The member register extract writes its entry on a WEB fixed at the call
    // site. Under a support session that would claim the administrator made
    // it themselves in the web interface (ADR 0028).
    await runForSupportSession("support-session-1", () =>
      service.record({
        action: "MEMBER_REGISTER_EXTRACT_GENERATED",
        channel: "WEB",
        actorPersonId: "administrator-1",
        context: { scope: "current" },
      }),
    );

    const entry = written(auditLogEntry);
    expect(entry.channel).toBe("SUPPORT");
    expect(entry.actorPersonId).toBe("administrator-1");
    expect(entry.context).toEqual({
      scope: "current",
      support: { session: "support-session-1" },
    });
  });

  it("holds through the work the request awaits", async () => {
    const { service, auditLogEntry } = build();

    await runForSupportSession("support-session-1", async () => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      await Promise.resolve();
      await service.record({ action: "MEDIA_ACCESSED", channel: "WEB" });
    });

    expect(written(auditLogEntry).channel).toBe("SUPPORT");
  });

  it("covers the audited reads and reveals, which write through record", async () => {
    const auditLogEntry = { create: vi.fn().mockResolvedValue({}) };
    const prisma = {
      auditLogEntry,
      $transaction: (work: (tx: unknown) => Promise<unknown>) =>
        work({ auditLogEntry }),
    };
    const service = new AuditLogService(prisma as unknown as PrismaService);

    await runForSupportSession("support-session-1", async () => {
      await service.withAuditedRead(
        { action: "MEMBER_REGISTER_EXTRACT_GENERATED", channel: "WEB" },
        () => Promise.resolve([]),
      );
      await service.recordProtectedDataReveal({
        actorPersonId: "administrator-1",
        targetPersonId: "person-2",
        channel: "WEB",
        fields: ["phone"],
      });
    });

    const channels = auditLogEntry.create.mock.calls.map(
      (call) => (call[0] as { data: { channel: string } }).data.channel,
    );
    expect(channels).toEqual(["SUPPORT", "SUPPORT"]);
  });

  it("overwrites a support key the caller wrote, rather than trusting it", async () => {
    const { service, auditLogEntry } = build();

    await runForSupportSession("support-session-1", () =>
      service.record({
        action: "MEDIA_ACCESSED",
        channel: "WEB",
        context: { support: { session: "somebody-else" } },
      }),
    );

    expect(written(auditLogEntry).context).toEqual({
      support: { session: "support-session-1" },
    });
  });

  it("names the session it was given outside a request, on SUPPORT", async () => {
    const { service, auditLogEntry } = build();

    await service.record({
      action: "SUPPORT_SESSION_STARTED",
      channel: "WEB",
      supportSessionId: "support-session-2",
      actorPersonId: "administrator-1",
    });

    const entry = written(auditLogEntry);
    expect(entry.channel).toBe("SUPPORT");
    expect(entry.context).toEqual({
      support: { session: "support-session-2" },
    });
  });

  it("leaves an entry outside a support session alone", async () => {
    const { service, auditLogEntry } = build();

    await service.record({ action: "MEDIA_ACCESSED", channel: "WEB" });

    const entry = written(auditLogEntry);
    expect(entry.channel).toBe("WEB");
    expect(entry.context).toBeUndefined();
  });
});

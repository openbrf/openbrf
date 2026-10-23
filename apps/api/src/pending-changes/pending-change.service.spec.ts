import { Logger } from "@nestjs/common";
import type { ActionDefinition } from "@openbrf/plugin-sdk";
import { describe, expect, it, vi } from "vite-plus/test";
import { z, ZodError } from "zod";

import {
  ActionCallerFactory,
  type RequestWithToken,
} from "../actions/action-caller";
import { ActionRegistryService } from "../actions/action-registry.service";
import { markAuthenticated } from "../actions/authenticated-request";
import { LiveResponse } from "../actions/testing/live-response";
import type { AuditLogService } from "../audit/audit-log.service";
import type { Principal } from "../authorization/capabilities";
import type { PrincipalService } from "../authorization/principal.service";
import type { Env } from "../config/env";
import type { PrismaService } from "../database/prisma.service";
import type { I18nService } from "../i18n/i18n.service";
import {
  PENDING_CHANGE_LIFETIME_MS,
  PendingChangeService,
} from "./pending-change.service";

/**
 * Arming, from proposal to confirmation (ADR 0039, §3).
 *
 * A plugin's action reaches a connected app only once an administrator has
 * armed it, and the confirmation runs on `web`, where arming governs nothing.
 * So the case that matters runs through both halves - the real registry, the
 * real caller factory and the real queue - with only the table stood in for:
 * armed, proposed through the app, disarmed, then confirmed by the person.
 */

interface Row {
  id: string;
  actionName: string;
  input: unknown;
  proposedByPersonId: string;
  channel: string;
  clientId: string | null;
  clientHost: string | null;
  proposedAt: Date;
  expiresAt: Date;
  dispatchedAt: Date | null;
}

/** The handful of queries the queue makes, over one in-memory table. */
function table() {
  const rows = new Map<string, Row>();
  const matches = (row: Row, where: Record<string, unknown>) =>
    Object.entries(where).every(([key, wanted]) => {
      const value = row[key as keyof Row];
      if (wanted !== null && typeof wanted === "object" && "gt" in wanted) {
        return (value as Date) > (wanted as { gt: Date }).gt;
      }
      return value === wanted;
    });
  const pendingChange = {
    create: vi.fn(
      async ({ data }: { data: Omit<Row, "id" | "dispatchedAt"> }) => {
        const row = {
          id: `pending-${String(rows.size + 1)}`,
          dispatchedAt: null,
          ...data,
        };
        rows.set(row.id, row);
        return { id: row.id, expiresAt: row.expiresAt };
      },
    ),
    findFirst: vi.fn(
      async ({ where }: { where: Record<string, unknown> }) =>
        [...rows.values()].find((row) => matches(row, where)) ?? null,
    ),
    findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
      [...rows.values()].filter((row) => matches(row, where)),
    ),
    updateMany: vi.fn(
      async ({
        where,
        data,
      }: {
        where: Record<string, unknown>;
        data: Partial<Row>;
      }) => {
        const found = [...rows.values()].filter((row) => matches(row, where));
        for (const row of found) Object.assign(row, data);
        return { count: found.length };
      },
    ),
    deleteMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
      const found = [...rows.values()].filter((row) => matches(row, where));
      for (const row of found) rows.delete(row.id);
      return { count: found.length };
    }),
  };
  const prisma = {
    pendingChange,
    // Rolled back when the work throws, as the database would.
    $transaction: async (work: (tx: unknown) => Promise<unknown>) => {
      const before = [...rows.values()].map((row) => ({ ...row }));
      try {
        return await work({ pendingChange });
      } catch (cause) {
        rows.clear();
        for (const row of before) rows.set(row.id, row);
        throw cause;
      }
    },
  } as unknown as PrismaService;
  return { prisma, rows };
}

interface BuildOptions {
  personalData?: ActionDefinition["personalData"];
  input?: z.ZodType;
}

function build({ personalData = [], input }: BuildOptions = {}) {
  const callers = new ActionCallerFactory();
  const principal = {
    personId: "person-1",
    capabilities: new Set(["self:manage", "site:manage"]),
  } as unknown as Principal;
  const principals = {
    forPerson: vi.fn(async () => principal),
  } as unknown as PrincipalService;
  const i18n = {
    translatorFor: () => (key: string) => key,
  } as unknown as I18nService;
  const env = {
    OPENBRF_ACTIONS_READ_ONLY: false,
    APP_URL: "https://brf.example",
  } as unknown as Env;
  const registry = new ActionRegistryService(callers, principals, i18n, env, {
    declared: true,
    path: "/api/plugin/connector/mcp",
    url: "https://brf.example/api/plugin/connector/mcp",
  });

  const handler = vi.fn(async (input: unknown) => input);
  registry.register(
    {
      name: "occupancy_note",
      titleKey: "actions.occupancy_note.title",
      descriptionKey: "actions.occupancy_note.description",
      group: "occupancy",
      groupTitleKey: "actions.group.occupancy.title",
      capability: "site:manage",
      effect: "write",
      idempotent: false,
      additive: true,
      needsConfirmation: false,
      openWorld: false,
      personalData,
      surfaces: ["ui", "mcp"],
      errors: [],
      input: input ?? z.strictObject({ note: z.string() }),
      output: z.strictObject({ note: z.string() }),
      handler,
    } as ActionDefinition,
    { kind: "plugin", pluginId: "occupancy" },
  );
  const plugin = {
    serving: true,
    armedActions: ["occupancy_note"] as string[],
    capabilityFloor: ["self:manage"],
  };
  // Read by the registry's admission, between the queue's lookup and its
  // claim: where a test lets time pass while the checks run.
  const admitting = vi.fn(async () => undefined);
  registry.bindLiveness({
    get: async () => {
      await admitting();
      return plugin;
    },
  });

  const { prisma, rows } = table();
  const record = vi.fn(async (_entry: { action: string }) => undefined);
  const audit = { record } as unknown as AuditLogService;
  const changes = new PendingChangeService(prisma, audit, registry, callers);
  return {
    changes,
    callers,
    plugin,
    handler,
    rows,
    admitting,
    record,
    registry,
  };
}

/** The person's own request: through the connected app, or on a session. */
function request(through: "app" | "session"): RequestWithToken {
  const held = {
    id: "req-1",
    principal: { personId: "person-1" },
    ...(through === "app"
      ? {
          token: {
            clientId: "assistant",
            clientHost: "assistant.example",
            scopes: ["mcp:write"],
            tokenRowId: "token-1",
          },
        }
      : {}),
  } as unknown as RequestWithToken;
  markAuthenticated(held, new LiveResponse(), {
    personId: "person-1",
    token:
      through === "app"
        ? {
            clientId: "assistant",
            clientHost: "assistant.example",
            scopes: ["mcp:write"],
          }
        : null,
    requestId: "req-1",
  });
  return held;
}

describe("proposing text that carries a personal identity number", () => {
  it("is refused with the path and not the number, and holds nothing", async () => {
    const { changes, callers, rows } = build();

    const refusal = await changes
      .propose(callers.forRequest(request("session")), "occupancy_note", {
        note: "Ring Anna, 19811218-9876.",
      })
      .catch((cause: unknown) => cause);

    expect(refusal).toBeInstanceOf(ZodError);
    const issues = (refusal as ZodError).issues;
    expect(issues.map((issue) => issue.path)).toEqual([["note"]]);
    expect(JSON.stringify(issues)).not.toContain("9876");
    expect(rows.size).toBe(0);
  });

  it("holds the same text for an action that declares personalIdentityNumber", async () => {
    const { changes, callers, rows } = build({
      personalData: ["personalIdentityNumber"],
    });

    const proposed = await changes.propose(
      callers.forRequest(request("session")),
      "occupancy_note",
      { note: "Ring Anna, 19811218-9876." },
    );

    expect(rows.get(proposed.id)?.input).toEqual({
      note: "Ring Anna, 19811218-9876.",
    });
  });

  // The walk reads string values, arrays and object values. It does not read
  // object keys, which is fine for the strict objects an action's schema is
  // made of; a schema that offered a record would need the keys scanned too.
  it("reports a number in a nested array by its whole path", async () => {
    const { changes, callers, rows } = build({
      input: z.strictObject({
        items: z.array(z.strictObject({ text: z.string() })),
      }),
    });

    const refusal = await changes
      .propose(callers.forRequest(request("session")), "occupancy_note", {
        items: [{ text: "Tvättstugan" }, { text: "Ring 19811218-9876." }],
      })
      .catch((cause: unknown) => cause);

    expect(refusal).toBeInstanceOf(ZodError);
    const issues = (refusal as ZodError).issues;
    expect(issues.map((issue) => issue.path)).toEqual([["items", 1, "text"]]);
    expect(JSON.stringify(issues)).not.toContain("9876");
    expect(rows.size).toBe(0);
  });
});

describe("confirming what a connected app proposed", () => {
  it("is refused once an administrator has disarmed the action, and leaves the change waiting", async () => {
    const { changes, callers, plugin, handler, rows } = build();
    const proposed = await changes.propose(
      callers.forRequest(request("app")),
      "occupancy_note",
      { note: "Tvättstugan stänger" },
    );

    plugin.armedActions = [];

    await expect(
      changes.confirm(request("session"), proposed.id),
    ).rejects.toMatchObject({ reason: "forbidden-surface" });
    expect(handler).not.toHaveBeenCalled();
    expect(rows.get(proposed.id)?.dispatchedAt).toBeNull();
  });

  it("runs as the confirming person on web while the action stays armed", async () => {
    const { changes, callers, handler, rows } = build();
    const proposed = await changes.propose(
      callers.forRequest(request("app")),
      "occupancy_note",
      { note: "Tvättstugan stänger" },
    );

    await changes.confirm(request("session"), proposed.id);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(
      { note: "Tvättstugan stänger" },
      expect.objectContaining({ channel: "web", pendingChangeId: proposed.id }),
    );
    expect(rows.has(proposed.id)).toBe(false);
  });
});

describe("confirming at the edge of its expiry", () => {
  it("does not run a change that lapsed while the registry checked it", async () => {
    const { changes, callers, handler, rows, admitting } = build();
    const entry = new Date("2026-10-20T00:00:00Z");
    const expiry = new Date("2026-10-20T00:00:01Z");
    const proposed = await changes.propose(
      callers.forRequest(request("app")),
      "occupancy_note",
      { note: "Tvättstugan stänger" },
      new Date(expiry.getTime() - PENDING_CHANGE_LIFETIME_MS),
    );

    // Pressed a second before its expiry; the checks finish a second after.
    let now = entry;
    admitting.mockImplementation(async () => {
      now = new Date("2026-10-20T00:00:02Z");
    });

    await expect(
      changes.confirm(request("session"), proposed.id, () => now),
    ).rejects.toMatchObject({ reason: "pending-change-not-found" });
    expect(admitting).toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
    expect(rows.get(proposed.id)?.dispatchedAt).toBeNull();
  });
});

describe("a confirmation the queue is read in the middle of", () => {
  // What the screen does after an answer it lost: it reads the queue again.
  // That read cannot tell it whether the change ran, so the screen must not
  // say it did not.
  it("lists a change its confirmation is still checking, which then runs once without another press", async () => {
    const { changes, callers, handler, rows, admitting } = build();
    const proposed = await changes.propose(
      callers.forRequest(request("app")),
      "occupancy_note",
      { note: "Tvättstugan stänger" },
    );
    let admit = (): void => undefined;
    admitting.mockImplementationOnce(
      () =>
        new Promise<undefined>((resolve) => {
          admit = () => {
            resolve(undefined);
          };
        }),
    );

    const confirming = changes.confirm(request("session"), proposed.id);
    await vi.waitFor(() => {
      expect(admitting).toHaveBeenCalledTimes(1);
    });

    const listed = await changes.mine("person-1", "sv");
    expect(listed.map((change) => change.id)).toEqual([proposed.id]);
    expect(handler).not.toHaveBeenCalled();

    admit();
    await confirming;

    expect(handler).toHaveBeenCalledTimes(1);
    expect(rows.has(proposed.id)).toBe(false);
    expect(await changes.mine("person-1", "sv")).toEqual([]);
  });

  it("resolves the targets of a long queue a batch at a time, and lists every change in order", async () => {
    const { changes, callers, registry } = build();
    const proposed: string[] = [];
    for (let n = 0; n < 25; n += 1) {
      proposed.push(
        (
          await changes.propose(
            callers.forRequest(request("app")),
            "occupancy_note",
            { note: `Anslag ${String(n)}` },
          )
        ).id,
      );
    }
    let running = 0;
    let peak = 0;
    vi.spyOn(registry, "targetOf").mockImplementation(async () => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, 1));
      running -= 1;
      return null;
    });

    const listed = await changes.mine("person-1", "sv");

    expect(listed.map((change) => change.id)).toEqual(proposed);
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(10);
  });

  it("runs the change once when it is confirmed again from that list", async () => {
    const { changes, callers, handler, admitting } = build();
    const proposed = await changes.propose(
      callers.forRequest(request("app")),
      "occupancy_note",
      { note: "Tvättstugan stänger" },
    );
    let admit = (): void => undefined;
    admitting.mockImplementationOnce(
      () =>
        new Promise<undefined>((resolve) => {
          admit = () => {
            resolve(undefined);
          };
        }),
    );

    const first = changes.confirm(request("session"), proposed.id);
    await vi.waitFor(() => {
      expect(admitting).toHaveBeenCalledTimes(1);
    });
    expect(
      (await changes.mine("person-1", "sv")).map((change) => change.id),
    ).toEqual([proposed.id]);

    // The second press finds it waiting and claims it first.
    await changes.confirm(request("session"), proposed.id);
    admit();

    await expect(first).rejects.toMatchObject({
      reason: "pending-change-not-found",
    });
    expect(handler).toHaveBeenCalledTimes(1);
  });
});

describe("a confirmation that fails after its action was dispatched", () => {
  it("says so when the action returned what its schema refuses, and does not run it again", async () => {
    const { changes, callers, handler, rows } = build();
    const proposed = await changes.propose(
      callers.forRequest(request("app")),
      "occupancy_note",
      { note: "Tvättstugan stänger" },
    );
    handler.mockResolvedValueOnce({ unexpected: true });

    await expect(
      changes.confirm(request("session"), proposed.id),
    ).rejects.toMatchObject({
      reason: "pending-change-failed-after-dispatch",
      status: 500,
      cause: expect.objectContaining({ reason: "output-invalid" }),
    });
    expect(rows.has(proposed.id)).toBe(false);

    await expect(
      changes.confirm(request("session"), proposed.id),
    ).rejects.toMatchObject({ reason: "pending-change-not-found" });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("says so when the action wrote and the confirmation could not be recorded", async () => {
    const { changes, callers, handler, rows, record } = build();
    const proposed = await changes.propose(
      callers.forRequest(request("app")),
      "occupancy_note",
      { note: "Tvättstugan stänger" },
    );
    record.mockImplementation(async (entry) => {
      if (entry.action === "PENDING_CHANGE_CONFIRMED") {
        throw new Error("The log is unavailable.");
      }
    });

    const logged = vi
      .spyOn(Logger.prototype, "error")
      .mockImplementation(() => undefined);
    try {
      await expect(
        changes.confirm(request("session"), proposed.id),
      ).rejects.toMatchObject({
        reason: "pending-change-failed-after-dispatch",
      });
      expect(logged).toHaveBeenCalledWith(
        expect.stringContaining(`Pending change ${proposed.id} ran`),
        expect.anything(),
      );
    } finally {
      logged.mockRestore();
    }
    // Left claimed for the sweep, and not waiting.
    expect(rows.get(proposed.id)?.dispatchedAt).toBeInstanceOf(Date);

    await expect(
      changes.confirm(request("session"), proposed.id),
    ).rejects.toMatchObject({ reason: "pending-change-not-found" });
    expect(handler).toHaveBeenCalledTimes(1);
  });
});

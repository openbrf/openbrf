import type { ActionDefinition } from "@openbrf/plugin-sdk";
import { describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import {
  ActionCallerFactory,
  type RequestWithToken,
} from "../actions/action-caller";
import { ActionRegistryService } from "../actions/action-registry.service";
import { markAuthenticated } from "../actions/authenticated-request";
import type { AuditLogService } from "../audit/audit-log.service";
import type { Principal } from "../authorization/capabilities";
import type { PrincipalService } from "../authorization/principal.service";
import type { Env } from "../config/env";
import type { PrismaService } from "../database/prisma.service";
import type { I18nService } from "../i18n/i18n.service";
import { PendingChangeService } from "./pending-change.service";

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
    $transaction: async (work: (tx: unknown) => Promise<unknown>) =>
      work({ pendingChange }),
  } as unknown as PrismaService;
  return { prisma, rows };
}

function build() {
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
      personalData: [],
      surfaces: ["ui", "mcp"],
      errors: [],
      input: z.strictObject({ note: z.string() }),
      output: z.strictObject({ note: z.string() }),
      handler,
    } as ActionDefinition,
    { kind: "plugin", pluginId: "occupancy" },
  );
  const plugin = {
    serving: true,
    armedActions: ["occupancy_note"] as string[],
    capabilityFloor: "self:manage",
  };
  registry.bindLiveness({ get: async () => plugin });

  const { prisma, rows } = table();
  const audit = {
    record: vi.fn(async () => undefined),
  } as unknown as AuditLogService;
  const changes = new PendingChangeService(prisma, audit, registry, callers);
  return { changes, callers, plugin, handler, rows };
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
  markAuthenticated(held);
  return held;
}

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

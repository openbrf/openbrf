import type { ActionDefinition, PluginManifest } from "@openbrf/plugin-sdk";
import { isActionRefusal } from "@openbrf/plugin-sdk";
import { Reflector } from "@nestjs/core";
import { firstValueFrom, throwError } from "rxjs";
import { describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import { ActionCallerFactory } from "../actions/action-caller";
import { ActionInputNames } from "../actions/action-input-names";
import { ActionRegistryService } from "../actions/action-registry.service";
import { markAuthenticated } from "../actions/authenticated-request";
import { LiveResponse } from "../actions/testing/live-response";
import type { AuditLogService } from "../audit/audit-log.service";
import type { Principal } from "../authorization/capabilities";
import type { PrincipalService } from "../authorization/principal.service";
import type { Env } from "../config/env";
import type { PrismaService } from "../database/prisma.service";
import { DomainError } from "../http/domain-error";
import type { I18nService } from "../i18n/i18n.service";
import { PendingChangeService } from "../pending-changes/pending-change.service";

import {
  createPluginHost,
  PluginHostBinding,
  type PluginHostServices,
} from "./plugin-host";
import { PluginErrorInterceptor } from "./plugin-error.interceptor";
import { PLUGIN_ID_METADATA } from "./plugin-module-seal";

/**
 * A refused proposal, as a plugin receives it.
 *
 * `host.actions.propose` is promised to be refused the same way as `invoke`
 * (the SDK's `PluginActions.propose`): a connector tells a refusal from a
 * fault with `isActionRefusal`, and a plugin route rethrowing one is answered
 * with the refusal's own status rather than as the plugin's failure. So the
 * case runs through the real host, queue, registry and caller factory, with
 * only the principal, the plugin's liveness and the table stood in for, and
 * checks that nothing ran and nothing was written.
 */

const MANIFEST = {
  id: "occupancy",
  name: "Occupancy",
  version: "1.0.0",
  deviceRoutes: [],
} as unknown as PluginManifest;

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
  registry.bindLiveness({
    get: async () => ({
      serving: true,
      armedActions: ["occupancy_note"],
      capabilityFloor: ["self:manage"],
    }),
  });

  const create = vi.fn();
  const transaction = vi.fn();
  const prisma = {
    pendingChange: { create },
    $transaction: transaction,
  } as unknown as PrismaService;
  const record = vi.fn();
  const changes = new PendingChangeService(
    prisma,
    { record } as unknown as AuditLogService,
    registry,
    callers,
    new ActionInputNames(),
  );

  const binding = new PluginHostBinding();
  binding.bind({
    callers,
    actions: registry,
    pendingChanges: changes,
  } as unknown as PluginHostServices);
  const host = createPluginHost(binding, {
    manifest: MANIFEST,
    consented: [],
    serving: true,
    bufferedActions: [],
    bufferedBlocks: [],
    bufferedExtensionPoints: [],
    bufferedContributions: [],
  });

  // The request the plugin's route received, marked as core marks it.
  const request = {
    id: "req-1",
    principal: { personId: "person-1" },
  } as unknown as Parameters<typeof host.actions.propose>[0];
  markAuthenticated(request as never, new LiveResponse(), {
    personId: "person-1",
    token: null,
    requestId: "req-1",
  });

  return { host, request, handler, create, transaction, record };
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => expect.unreachable("the proposal was refused"),
    (cause: unknown) => cause,
  );
}

describe("a refused proposal, as a plugin receives it", () => {
  it("rejects a malformed input as the refusal invoke gives, naming paths and not values", async () => {
    const { host, request, handler, create, transaction, record } = build();

    const refused = await rejection(
      host.actions.propose(request, "occupancy_note", { note: 1234567 }),
    );

    if (!isActionRefusal(refused)) {
      throw new Error("not a refusal");
    }
    expect(refused).toMatchObject({
      kind: "invalid-body",
      reason: "invalid-body",
      status: 400,
    });
    const { issues } = refused.details() as { issues: { path: string }[] };
    expect(issues.map((issue) => issue.path)).toEqual(["note"]);
    expect(JSON.stringify(issues)).not.toContain("1234567");

    expect(handler).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
  });

  it("rejects an unknown action as a registry refusal", async () => {
    const { host, request, handler, create, transaction } = build();

    const refused = await rejection(
      host.actions.propose(request, "no_such_action", {}),
    );

    expect(isActionRefusal(refused)).toBe(true);
    expect(refused).toMatchObject({ kind: "registry", status: 404 });
    expect(handler).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it("answers a route rethrowing a malformed proposal with its 400, not a bad gateway", async () => {
    const { host, request } = build();
    class Controller {}
    Reflect.defineMetadata(PLUGIN_ID_METADATA, "occupancy", Controller);
    const interceptor = new PluginErrorInterceptor(new Reflector());

    const refused = await rejection(
      host.actions.propose(request, "occupancy_note", { note: 1234567 }),
    );
    const answered = await rejection(
      firstValueFrom(
        interceptor.intercept(
          {
            getClass: () => Controller,
            getHandler: () => function propose(): void {},
          } as never,
          { handle: () => throwError(() => refused) },
        ),
      ),
    );

    // Passed through for the domain filter to answer with its own status.
    expect(answered).toBe(refused);
    expect(answered).toBeInstanceOf(DomainError);
    expect(answered).toMatchObject({ status: 400, reason: "invalid-body" });
  });

  it("leaves a failure that is not a refusal as it was thrown", async () => {
    const { host, request, create, transaction } = build();
    const fault = new Error("the database is down");
    transaction.mockRejectedValue(fault);

    const failed = await rejection(
      host.actions.propose(request, "occupancy_note", { note: "ok" }),
    );

    expect(failed).toBe(fault);
    expect(isActionRefusal(failed)).toBe(false);
    expect(create).not.toHaveBeenCalled();
  });
});

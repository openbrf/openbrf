import type { ActionSummary } from "@openbrf/plugin-sdk";
import type { FastifyReply } from "fastify";
import { describe, expect, it } from "vitest";

import type { RequestWithPrincipal } from "../authorization/authorization.guard";
import type { ActionCallerFactory } from "./action-caller";
import type {
  ActionListFilter,
  ActionRegistryService,
} from "./action-registry.service";
import type { Capability } from "../authorization/capabilities";
import { IS_PUBLIC_ROUTE } from "../authorization/public.decorator";
import { REQUIRED_CAPABILITIES } from "../authorization/require-capability.decorator";
import { ActionCatalogueController } from "./action-catalogue.controller";
import { ACTION_ERROR_MCP } from "./action.error";

/**
 * What the catalogue demands of whoever reads it.
 *
 * Two mistakes are possible here and they fail in opposite directions, which is
 * why both are asserted rather than one. Making it public would publish which
 * plugins a named cooperative runs to anyone who asks - a fact about the
 * association, not about the platform. Gating it on a capability would hide the
 * catalogue from residents, whose own actions are exactly what the AI package
 * will later offer them.
 *
 * A valid session and nothing more is the answer, and under the global guard
 * that state is spelled "declares no capability and is not public" - an absence
 * on both counts, which is precisely the shape a test has to pin, because
 * nothing about the file says it out loud.
 */

function requiredOnClass(target: object): Capability[] | undefined {
  return Reflect.getMetadata(REQUIRED_CAPABILITIES, target) as
    Capability[] | undefined;
}

function requiredOn(
  controller: object,
  method: string,
): Capability[] | undefined {
  const handler = (controller as Record<string, unknown>)[method];
  return Reflect.getMetadata(REQUIRED_CAPABILITIES, handler as object) as
    Capability[] | undefined;
}

/** One route handler, read off the prototype without binding it. */
function handler(controller: object, method: string): object {
  return (controller as Record<string, object>)[method] as object;
}

function isPublic(target: object): boolean | undefined {
  return Reflect.getMetadata(IS_PUBLIC_ROUTE, target) as boolean | undefined;
}

describe("who may read the action catalogue", () => {
  const prototype = ActionCatalogueController.prototype;

  it("demands a session and no capability", () => {
    expect(requiredOnClass(ActionCatalogueController)).toBeUndefined();
    expect(requiredOn(prototype, "list")).toBeUndefined();
    expect(requiredOn(prototype, "byName")).toBeUndefined();
  });

  it("is not public, on the class or on either route", () => {
    // An unauthenticated catalogue would tell the internet which plugins this
    // association has installed.
    expect(isPublic(ActionCatalogueController)).not.toBe(true);
    expect(isPublic(handler(prototype, "list"))).not.toBe(true);
    expect(isPublic(handler(prototype, "byName"))).not.toBe(true);
  });
});

describe("looking up one action", () => {
  it("answers on the surface the list was read on", async () => {
    // An action offered on "mcp" alone is in `?surface=mcp`; looking it up by
    // name on the same surface must not answer that it does not exist.
    const summary: ActionSummary = {
      name: "news_list",
      title: "List news",
      description: "Lists the news items the caller may read.",
      titleKey: "actions.news_list.title",
      descriptionKey: "actions.news_list.description",
      group: "news",
      groupTitle: "News",
      groupTitleKey: "actions.groups.news",
      capability: "news:read",
      effect: "read",
      idempotent: true,
      additive: false,
      needsConfirmation: false,
      openWorld: false,
      personalData: [],
      surfaces: ["mcp"],
      errors: [],
    };
    const registry = {
      list: async (_caller: unknown, filter?: ActionListFilter) =>
        filter?.surface === "mcp" ? [summary] : [],
      inputJsonSchema: () => ({}),
      outputJsonSchema: () => ({}),
    } as unknown as ActionRegistryService;
    const callers = {
      forRequest: () => ({}),
    } as unknown as ActionCallerFactory;
    const controller = new ActionCatalogueController(registry, callers);
    const request = { headers: {} } as RequestWithPrincipal;
    const reply = { header: () => reply } as unknown as FastifyReply;

    await expect(
      controller.byName(
        { name: "news_list" },
        { surface: "mcp" },
        request,
        reply,
      ),
    ).resolves.toEqual({
      ...summary,
      inputSchema: {},
      outputSchema: {},
      errorHandling: ACTION_ERROR_MCP,
    });
  });
});

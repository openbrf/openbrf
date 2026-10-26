import type { ActionContext, ActionDefinition } from "@openbrf/plugin-sdk";
import { describe, expect, it, vi } from "vite-plus/test";
import { z, ZodError } from "zod";

import { auditActor } from "../audit/actor-context";
import type { Principal } from "../authorization/capabilities";
import type { PrincipalService } from "../authorization/principal.service";
import type { Env } from "../config/env";
import type { I18nService } from "../i18n/i18n.service";
import { ActionCallerFactory, type RequestWithToken } from "./action-caller";
import { ActionRegistryService } from "./action-registry.service";
import { ActionError } from "./action.error";
import { actorOf } from "./actor-of";
import type { ActionTargetFact, CoreActionDefinition } from "./core-action";
import { markAuthenticated } from "./authenticated-request";
import { LiveResponse } from "./testing/live-response";

/**
 * The one place a capability is checked for every action.
 *
 * The cases below are written against the ORDER of the checks as much as
 * against their outcomes, because the order is load-bearing in two directions.
 * A refusal that ran late would have already read the database, which turns a
 * forbidden call into a way of asking what exists; a refusal that ran early on
 * something caller-dependent would tell one caller from another. So each
 * failing case asserts the outcome and that the handler was never reached.
 */

function definition(
  overrides: Partial<ActionDefinition> = {},
): ActionDefinition {
  return {
    name: "news_publish",
    titleKey: "actions.news_publish.title",
    descriptionKey: "actions.news_publish.description",
    group: "news",
    groupTitleKey: "actions.group.news.title",
    capability: "site:manage",
    effect: "write",
    idempotent: true,
    additive: false,
    needsConfirmation: false,
    openWorld: false,
    personalData: [],
    surfaces: ["ui", "mcp"],
    errors: [],
    input: z.strictObject({ id: z.string() }),
    output: z.strictObject({ id: z.string() }),
    handler: vi.fn(async (input: unknown) => input),
    ...overrides,
  } as ActionDefinition;
}

function build(options: { capabilities?: string[]; readOnly?: boolean } = {}) {
  const callers = new ActionCallerFactory();
  const principal = {
    personId: "person-1",
    capabilities: new Set(options.capabilities ?? ["site:manage"]),
  } as unknown as Principal;
  const forPerson = vi.fn(async () => principal);
  const principals = { forPerson } as unknown as PrincipalService;
  const i18n = {
    translatorFor: () => (key: string) => key,
  } as unknown as I18nService;
  const env = {
    OPENBRF_ACTIONS_READ_ONLY: options.readOnly ?? false,
    // The insufficient-scope refusal builds a challenge against this, so a
    // fixture without it turns a clean 403 into a URL parse failure.
    APP_URL: "https://brf.example",
  } as unknown as Env;

  const registry = new ActionRegistryService(callers, principals, i18n, env, {
    declared: true,
    path: "/api/plugin/connector/mcp",
    url: "https://brf.example/api/plugin/connector/mcp",
  });
  return { registry, callers, forPerson };
}

function request(token?: RequestWithToken["token"]): RequestWithToken {
  const held = {
    id: "req-1",
    principal: { personId: "person-1" },
    ...(token === undefined ? {} : { token }),
  } as unknown as RequestWithToken;
  markAuthenticated(held, new LiveResponse(), {
    personId: "person-1",
    token: token ?? null,
    requestId: "req-1",
  });
  return held;
}

describe("what may be registered", () => {
  it("refuses two actions claiming one name", () => {
    const { registry } = build();
    registry.register(definition(), { kind: "core", module: "news" });

    expect(() =>
      registry.register(definition(), { kind: "core", module: "news" }),
    ).toThrow(/claim the name/);
  });

  it("refuses an alias that collides with a name", () => {
    const { registry } = build();
    registry.register(definition(), { kind: "core", module: "news" });

    expect(() =>
      registry.register(
        definition({ name: "news_post", deprecatedAliases: ["news_publish"] }),
        { kind: "core", module: "news" },
      ),
    ).toThrow(/claim the name/);
  });

  it("refuses a schema that cannot be published, at registration", () => {
    // Rather than when something asks for the document: a schema that cannot
    // be rendered is a defect in the action, and the moment to say so is
    // before anything can call it.
    const { registry } = build();

    expect(() =>
      registry.register(
        definition({ input: z.strictObject({ from: z.date() }) }),
        { kind: "core", module: "news" },
      ),
    ).toThrow(/news_publish/);
  });

  it("refuses a core action declaring a capability by which authority moves", () => {
    // Beslutslogg 64, core actions included. The plugin gate refuses this over
    // a manifest; a core action passes through no gate but this one.
    const { registry } = build();

    expect(() =>
      registry.register(definition({ capability: "boardPosition:manage" }), {
        kind: "core",
        module: "news",
      }),
    ).toThrow(/news_publish.*boardPosition:manage/);
  });

  it("refuses a core action whose name describes an act no action may perform", () => {
    const { registry } = build();

    expect(() =>
      registry.register(definition({ name: "residency_end" }), {
        kind: "core",
        module: "news",
      }),
    ).toThrow(/residency_end/);
  });

  it("refuses a core action whose alias describes an act no action may perform", () => {
    // An alias resolves to the action through get(), so it is a second name
    // for it and is held to the same rule.
    const { registry } = build();

    expect(() =>
      registry.register(definition({ deprecatedAliases: ["residency_end"] }), {
        kind: "core",
        module: "news",
      }),
    ).toThrow(/news_publish.*"residency_end"/);
  });
});

/**
 * Rule 1, the exposure rule, refused before anything can call the action.
 *
 * Beslutslogg 64 puts protected personal data (skyddade personuppgifter)
 * outside every token and every prompt. The plugin gate refuses the same thing
 * over a manifest, where a board can still act on it; a core action passes
 * through none of that, so the rule is refused here as well - over the
 * definition rather than over the declaration, which is what makes it hold for
 * core and plugin alike.
 *
 * Read as a binding rule rather than as a declaration rule it decides more than
 * it appears to. An action declaring `protected` may be offered on `ui` and
 * nowhere else, and an action offered only on `ui` reaches nothing a connected
 * app can call - so an action worth registering is one that cannot return
 * protected personal data at all, which is a property of the service method its
 * handler calls.
 */
describe("what an action touching protected personal data may be offered on", () => {
  it("refuses one offered to a connected app", () => {
    const { registry } = build();

    expect(() =>
      registry.register(
        definition({
          personalData: ["name", "protected"],
          surfaces: ["ui", "mcp"],
        }),
        { kind: "core", module: "news" },
      ),
    ).toThrow(/news_publish.*mcp/);
  });

  it("refuses one offered to the AI package", () => {
    const { registry } = build();

    expect(() =>
      registry.register(
        definition({ personalData: ["protected"], surfaces: ["ai"] }),
        { kind: "core", module: "news" },
      ),
    ).toThrow(/news_publish.*ai/);
  });

  it("names both surfaces when an action asks for both", () => {
    // One refusal naming what is wrong with the definition, rather than one
    // that has to be met twice.
    const { registry } = build();

    expect(() =>
      registry.register(
        definition({ personalData: ["protected"], surfaces: ["mcp", "ai"] }),
        { kind: "core", module: "news" },
      ),
    ).toThrow(/mcp, ai/);
  });

  it("registers one offered in the product and nowhere else", () => {
    // The rule is about reaching beyond the instance. A screen inside it is
    // where a board member reads a protected person's own register entry, and
    // that path is unchanged.
    const { registry } = build();

    expect(() =>
      registry.register(
        definition({ personalData: ["protected"], surfaces: ["ui"] }),
        { kind: "core", module: "news" },
      ),
    ).not.toThrow();
  });

  it("leaves an action declaring nothing alone", () => {
    // The control case: the gate must not misfire on the honest empty
    // declaration that most core actions carry.
    const { registry } = build();

    expect(() =>
      registry.register(definition({ personalData: [] }), {
        kind: "core",
        module: "news",
      }),
    ).not.toThrow();
  });

  it("refuses a plugin's action on the same rule", () => {
    /*
     * The manifest gate would have refused this earlier, and deliberately
     * still does. Two moments over two different objects rather than two
     * opinions: a manifest declaration and a registered definition can
     * disagree, and a later change that made either read the other would
     * collapse a distinction that exists because they can.
     */
    const { registry } = build();

    expect(() =>
      registry.register(
        definition({
          name: "plugin_thing",
          personalData: ["protected"],
          surfaces: ["mcp"],
        }),
        { kind: "plugin", pluginId: "example" },
      ),
    ).toThrow(/plugin_thing/);
  });
});

describe("what a caller reaches", () => {
  it("dispatches through an alias but never advertises one", async () => {
    // An MCP client caches tools/list at initialisation and does not refresh
    // on a schema change, so a renamed action keeps answering to its old name
    // while only the new one is offered.
    const { registry, callers } = build();
    registry.register(definition({ deprecatedAliases: ["news_post"] }), {
      kind: "core",
      module: "news",
    });
    const caller = callers.forRequest(request());

    await expect(
      registry.invoke(caller, "news_post", { id: "news-1" }),
    ).resolves.toEqual({ id: "news-1" });

    const listed = await registry.list(caller);
    expect(listed.map((action) => action.name)).toEqual(["news_publish"]);
  });

  it("offers nothing on a surface the action does not declare", async () => {
    const { registry, callers } = build();
    registry.register(definition({ surfaces: ["ui"] }), {
      kind: "core",
      module: "news",
    });

    const caller = callers.forRequest(
      request({
        clientId: "c",
        clientHost: null,
        scopes: ["mcp:write"],
        tokenRowId: "token-c",
      }),
    );

    expect(await registry.list(caller)).toEqual([]);
  });

  it("offers nothing the caller could not call", async () => {
    const { registry, callers } = build({ capabilities: ["self:manage"] });
    registry.register(definition(), { kind: "core", module: "news" });

    expect(await registry.list(callers.forRequest(request()))).toEqual([]);
  });

  it("lets a person on a session ask what another surface would offer", async () => {
    /*
     * The direction that stays open, and the reason it is open. A member being
     * shown what an external app would be able to do as them, before they grant
     * it, is what informed consent on the sign-in screen is made of - so a web
     * caller may name a surface. It is safe because naming "mcp" makes
     * `permits()` demand the arming, and because the list is filtered to this
     * person's own live capabilities whichever surface is asked for.
     */
    const { registry, callers } = build();
    registry.register(definition({ surfaces: ["ui", "mcp"] }), {
      kind: "core",
      module: "news",
    });
    registry.register(
      definition({ name: "news_draft_only", surfaces: ["ui"] }),
      { kind: "core", module: "news" },
    );

    const onUi = callers.forRequest(request());

    // Unfiltered: everything this channel reaches.
    expect((await registry.list(onUi)).map((one) => one.name)).toEqual([
      "news_draft_only",
      "news_publish",
    ]);
    // Narrowed: only the one that is also offered there.
    expect(
      (await registry.list(onUi, { surface: "mcp" })).map((one) => one.name),
    ).toEqual(["news_publish"]);
    // A surface nothing declares is not a way back in.
    expect(await registry.list(onUi, { surface: "ai" })).toEqual([]);
  });
});

describe("the order the refusals come in", () => {
  it("refuses an unknown name without reading anything", async () => {
    const { registry, callers, forPerson } = build();

    await expect(
      registry.invoke(callers.forRequest(request()), "no_such_action", {}),
    ).rejects.toMatchObject({ reason: "unknown-action", status: 404 });
    expect(forPerson).not.toHaveBeenCalled();
  });

  it("refuses a surface before touching the database", async () => {
    // Before any read, so that a refusal cannot be used to ask what exists.
    const { registry, callers, forPerson } = build();
    const held = definition({ surfaces: ["ui"] });
    registry.register(held, { kind: "core", module: "news" });

    const caller = callers.forRequest(
      request({
        clientId: "c",
        clientHost: null,
        scopes: ["mcp:write"],
        tokenRowId: "token-c",
      }),
    );

    await expect(
      registry.invoke(caller, "news_publish", {}),
    ).rejects.toMatchObject({ reason: "forbidden-surface" });
    expect(forPerson).not.toHaveBeenCalled();
    expect(held.handler).not.toHaveBeenCalled();
  });

  it("refuses a write in read-only mode whoever asks", async () => {
    // Unconditional and above every caller-dependent check, so the answer does
    // not depend on who asked.
    const { registry, callers, forPerson } = build({ readOnly: true });
    const held = definition();
    registry.register(held, { kind: "core", module: "news" });

    await expect(
      registry.invoke(callers.forRequest(request()), "news_publish", {
        id: "news-1",
      }),
    ).rejects.toMatchObject({ reason: "read-only", status: 409 });
    expect(forPerson).not.toHaveBeenCalled();
    expect(held.handler).not.toHaveBeenCalled();
  });

  it("lets a read through in read-only mode", async () => {
    const { registry, callers } = build({ readOnly: true });
    registry.register(definition({ effect: "read" }), {
      kind: "core",
      module: "news",
    });

    await expect(
      registry.invoke(callers.forRequest(request()), "news_publish", {
        id: "news-1",
      }),
    ).resolves.toEqual({ id: "news-1" });
  });

  it("names the scope it wanted, above the capability check", async () => {
    // The refusal is scope-shaped and can name a scope; a capability refusal
    // cannot name a capability, which is the cost of two coarse scopes and is
    // written into ADR 0009.
    const { registry, callers, forPerson } = build();
    registry.register(definition(), { kind: "core", module: "news" });

    const caller = callers.forRequest(
      request({
        clientId: "c",
        clientHost: null,
        scopes: ["mcp:read"],
        tokenRowId: "token-c",
      }),
    );

    await expect(
      registry.invoke(caller, "news_publish", { id: "news-1" }),
    ).rejects.toMatchObject({ reason: "insufficient-scope" });
    expect(forPerson).not.toHaveBeenCalled();
  });

  it("re-derives the capability on every call rather than trusting the token", async () => {
    const { registry, callers, forPerson } = build({
      capabilities: ["self:manage"],
    });
    const held = definition();
    registry.register(held, { kind: "core", module: "news" });

    await expect(
      registry.invoke(callers.forRequest(request()), "news_publish", {
        id: "news-1",
      }),
    ).rejects.toMatchObject({ reason: "forbidden-capability", status: 403 });
    // Asked, and asked now: this is the line that makes a token never exceed
    // what the person may do at the instant of the call.
    expect(forPerson).toHaveBeenCalledWith("person-1");
    expect(held.handler).not.toHaveBeenCalled();
  });

  it("answers a malformed body as every controller does", async () => {
    // The standard entry point returns its issues rather than throwing, so
    // without the rethrow a malformed body would reach the handler as a typed
    // value it is not.
    const { registry, callers } = build();
    const held = definition();
    registry.register(held, { kind: "core", module: "news" });

    await expect(
      registry.invoke(callers.forRequest(request()), "news_publish", {
        id: 7,
      }),
    ).rejects.toMatchObject({ name: "ZodError" });
    expect(held.handler).not.toHaveBeenCalled();
  });

  it("refuses a value the action's own output schema rejects", async () => {
    // A service that widened its return type must not silently ship a new
    // field to a model.
    const { registry, callers } = build();
    registry.register(
      definition({ handler: async () => ({ id: "news-1", secret: "x" }) }),
      { kind: "core", module: "news" },
    );

    await expect(
      registry.invoke(callers.forRequest(request()), "news_publish", {
        id: "news-1",
      }),
    ).rejects.toMatchObject({ reason: "output-invalid", status: 500 });
  });
});

describe("what the audit entry names", () => {
  /*
   * The fields a write service spreads into its audit entry, from the context
   * the handler was given. ADR 0038, question 4: an entry a plugin's dispatch
   * wrote names the plugin, as one a connected app wrote names the app.
   */
  async function audited(
    mint: (
      callers: ActionCallerFactory,
    ) => ReturnType<ActionCallerFactory["forRequest"]>,
  ) {
    const { registry, callers } = build();
    const handler = vi.fn(
      async (input: unknown, _context: ActionContext) => input,
    );
    registry.register(definition({ handler }), {
      kind: "core",
      module: "news",
    });

    await registry.invoke(mint(callers), "news_publish", { id: "a" });

    const context = handler.mock.calls[0]?.[1];
    if (context === undefined) {
      throw new Error("The handler was not reached.");
    }
    return auditActor(actorOf(context));
  }

  const PARKING = { id: "parking", ai: false } as const;
  const TOKEN = {
    clientId: "client-1",
    clientHost: "claude.ai",
    scopes: ["mcp:write"],
    tokenRowId: "token-client-1",
  };

  it("names the plugin whose route dispatched for a signed-in person", async () => {
    expect(
      await audited((callers) => callers.forPlugin(request(), PARKING)),
    ).toEqual({
      channel: "PLUGIN",
      actorPersonId: "person-1",
      clientId: null,
      clientHost: null,
      pluginId: "parking",
      pendingChangeId: null,
    });
  });

  it("names both the app and the plugin when a token reached the plugin's route", async () => {
    expect(
      await audited((callers) => callers.forPlugin(request(TOKEN), PARKING)),
    ).toEqual({
      channel: "MCP",
      actorPersonId: "person-1",
      clientId: "client-1",
      clientHost: "claude.ai",
      pluginId: "parking",
      pendingChangeId: null,
    });
  });

  it("names no plugin when none dispatched", async () => {
    expect(
      (await audited((callers) => callers.forRequest(request()))).pluginId,
    ).toBeNull();
    expect(
      (await audited((callers) => callers.forRequest(request(TOKEN)))).pluginId,
    ).toBeNull();
  });
});

describe("what a plugin's action depends on", () => {
  const pluginAction = () =>
    definition({ name: "occupancy_summary", capability: "self:manage" });

  function withPlugin(
    state: {
      serving: boolean;
      armedActions: readonly string[];
      capabilityFloor: readonly string[];
    } | null,
  ) {
    const built = build({ capabilities: ["self:manage", "site:manage"] });
    built.registry.register(pluginAction(), {
      kind: "plugin",
      pluginId: "occupancy",
    });
    built.registry.bindLiveness({
      get: async () =>
        state === null
          ? null
          : { ...state, personalData: [], websiteBlocks: false },
    });
    return built;
  }

  it("is unreachable while the plugin is not serving", async () => {
    // Answered as not-serving, a 404 like an unknown name, rather than as a
    // 403 that would confirm the action exists.
    const { registry, callers } = withPlugin({
      serving: false,
      armedActions: ["occupancy_summary"],
      capabilityFloor: ["self:manage"],
    });

    await expect(
      registry.invoke(callers.forRequest(request()), "occupancy_summary", {
        id: "a",
      }),
    ).rejects.toMatchObject({ reason: "not-serving", status: 404 });
  });

  it("is unreachable while the plugin is not known to be serving at all", async () => {
    const { registry, callers } = withPlugin(null);

    await expect(
      registry.invoke(callers.forRequest(request()), "occupancy_summary", {
        id: "a",
      }),
    ).rejects.toMatchObject({ reason: "not-serving", status: 404 });
  });

  it("is unreachable through a connected app until an administrator arms it", async () => {
    // Declaring an action is a proposal; arming it is the act that exposes it.
    const { registry, callers } = withPlugin({
      serving: true,
      armedActions: [],
      capabilityFloor: ["self:manage"],
    });

    const caller = callers.forRequest(
      request({
        clientId: "c",
        clientHost: null,
        scopes: ["mcp:write"],
        tokenRowId: "token-c",
      }),
    );

    await expect(
      registry.invoke(caller, "occupancy_summary", { id: "a" }),
    ).rejects.toMatchObject({ reason: "forbidden-surface" });
  });

  it("is reachable in process without arming, which only governs the other surfaces", async () => {
    const { registry, callers } = withPlugin({
      serving: true,
      armedActions: [],
      capabilityFloor: ["self:manage"],
    });

    await expect(
      registry.invoke(callers.forRequest(request()), "occupancy_summary", {
        id: "a",
      }),
    ).resolves.toEqual({ id: "a" });
  });

  it("does not let a connected app ask for the surface it is not on", async () => {
    /*
     * "ui" is the one surface a plugin's action is reached on with no arming
     * test at all, which is right for something inside this process and exactly
     * wrong for something outside it. A program allowed to name it would read
     * back the names, descriptions and capabilities of every plugin action an
     * administrator deliberately did not offer it.
     *
     * That branch is the whole of the leak: on "mcp" and "ai" the filter was
     * always honoured correctly, because those two make `permits()` demand the
     * arming.
     */
    const { registry, callers } = withPlugin({
      serving: true,
      armedActions: [],
      capabilityFloor: ["self:manage"],
    });

    const caller = callers.forRequest(
      request({
        clientId: "c",
        clientHost: null,
        scopes: ["mcp:read"],
        tokenRowId: "token-c",
      }),
    );

    expect(await registry.list(caller, { surface: "ui" })).toEqual([]);
  });

  it("does not let a plugin choose one either, though it runs in process", async () => {
    /*
     * The channel that is easy to get wrong. `plugin` maps to "ui", so a rule
     * keyed on the entitled surface rather than on the channel would have let a
     * plugin name "mcp" and read back what an administrator armed for connected
     * apps. It is a program, and only a person on a session may ask.
     */
    const { registry, callers } = withPlugin({
      serving: true,
      armedActions: ["occupancy_summary"],
      capabilityFloor: ["self:manage"],
    });

    const inProcess = callers.forPlugin(request(), {
      id: "occupancy",
      ai: false,
    });
    registry.register(definition({ name: "news_ui_only", surfaces: ["ui"] }), {
      kind: "core",
      module: "news",
    });

    // The "ui" listing, whatever was asked for: the ui-only action is in it.
    expect(
      (await registry.list(inProcess, { surface: "mcp" })).map(
        (one) => one.name,
      ),
    ).toEqual(["news_ui_only", "occupancy_summary"]);
  });

  it("still honours arming when a person asks about another surface", async () => {
    /*
     * The case that must not regress, and the reason `permits()` is asked about
     * the surface being LISTED rather than about the caller's own channel.
     * Judging by the channel would make this read "ui", where arming is not
     * tested - and the sign-in consent screen would then show a member actions
     * the app could not in fact perform, at the moment they are deciding
     * whether to grant it.
     */
    const { registry, callers } = withPlugin({
      serving: true,
      armedActions: [],
      capabilityFloor: ["self:manage"],
    });
    const onSession = callers.forRequest(request());

    // Unarmed: in process it is reachable, and to a connected app it is not.
    expect((await registry.list(onSession)).map((one) => one.name)).toEqual([
      "occupancy_summary",
    ]);
    expect(await registry.list(onSession, { surface: "mcp" })).toEqual([]);

    registry.bindLiveness({
      get: async () => ({
        serving: true,
        armedActions: ["occupancy_summary"],
        capabilityFloor: ["self:manage"],
        personalData: [],
        websiteBlocks: false,
      }),
    });
    expect(
      (await registry.list(onSession, { surface: "mcp" })).map(
        (one) => one.name,
      ),
    ).toEqual(["occupancy_summary"]);
  });

  it("refuses a caller the plugin's own routes would refuse", async () => {
    // Decision 23's property: an action is never a way around the floor the
    // seal puts on the plugin's own routes.
    const { registry, callers } = withPlugin({
      serving: true,
      armedActions: ["occupancy_summary"],
      capabilityFloor: ["addressBook:read"],
    });

    await expect(
      registry.invoke(callers.forRequest(request()), "occupancy_summary", {
        id: "a",
      }),
    ).rejects.toMatchObject({ reason: "forbidden-capability" });
  });

  it("does not offer it to a caller the plugin's own routes would refuse", async () => {
    // The listing half of the floor check above. A catalogue is never a list
    // of things to be refused, and the name and description of an action are
    // themselves something the plugin's routes would not have shown.
    const { registry, callers } = withPlugin({
      serving: true,
      armedActions: ["occupancy_summary"],
      capabilityFloor: ["addressBook:read"],
    });

    expect(await registry.list(callers.forRequest(request()))).toEqual([]);
    expect(
      await registry.list(callers.forRequest(request()), { surface: "mcp" }),
    ).toEqual([]);
  });

  it("disappears with the plugin", async () => {
    const { registry, callers } = withPlugin({
      serving: true,
      armedActions: ["occupancy_summary"],
      capabilityFloor: ["self:manage"],
    });

    registry.unregisterOwner({ kind: "plugin", pluginId: "occupancy" });

    expect(registry.get("occupancy_summary")).toBeNull();
    await expect(
      registry.invoke(callers.forRequest(request()), "occupancy_summary", {
        id: "a",
      }),
    ).rejects.toMatchObject({ reason: "unknown-action" });
  });

  it("takes its aliases with it", () => {
    const built = build();
    built.registry.register(
      definition({ name: "occupancy_summary", deprecatedAliases: ["occ_sum"] }),
      { kind: "plugin", pluginId: "occupancy" },
    );

    built.registry.unregisterOwner({ kind: "plugin", pluginId: "occupancy" });

    expect(built.registry.get("occ_sum")).toBeNull();
    // And the name is free again, so a reinstall does not collide with itself.
    expect(() =>
      built.registry.register(definition({ name: "occupancy_summary" }), {
        kind: "plugin",
        pluginId: "occupancy",
      }),
    ).not.toThrow();
  });

  it("leaves another owner's actions alone", () => {
    const built = build();
    built.registry.register(definition(), { kind: "core", module: "news" });
    built.registry.register(definition({ name: "occupancy_summary" }), {
      kind: "plugin",
      pluginId: "occupancy",
    });

    built.registry.unregisterOwner({ kind: "plugin", pluginId: "occupancy" });

    expect(built.registry.get("news_publish")).not.toBeNull();
  });
});

/**
 * A plugin dispatching an action handles the personal data the action does,
 * so it reaches only the actions its own declaration covers. Otherwise a
 * plugin with no permission to read the register, one that puts blocks on the
 * website among them, could be handed names by a core action a person on its
 * route may call.
 */
describe("what a plugin's declared personal data lets it dispatch", () => {
  const NOTICEBOARD = { id: "noticeboard", ai: false } as const;

  function withDispatcher(
    personalData: readonly string[],
    websiteBlocks = false,
  ) {
    const built = build({ capabilities: ["site:manage"] });
    const named = definition({
      name: "news_comment_list",
      effect: "read",
      surfaces: ["ui"],
      personalData: ["name", "freeText"],
    });
    built.registry.register(named, { kind: "core", module: "news" });
    built.registry.register(
      definition({ name: "news_list", effect: "read", surfaces: ["ui"] }),
      { kind: "core", module: "news" },
    );
    const lookup = vi.fn(async (pluginId: string) =>
      pluginId === NOTICEBOARD.id
        ? {
            serving: true,
            armedActions: [],
            capabilityFloor: ["self:manage"],
            personalData,
            websiteBlocks,
          }
        : null,
    );
    built.registry.bindLiveness({ get: lookup });
    return { ...built, named, lookup };
  }

  it("refuses an action handling what the plugin did not declare, and names it", async () => {
    const { registry, callers, named } = withDispatcher(["name"]);

    const refusal = await registry
      .invoke(callers.forPlugin(request(), NOTICEBOARD), "news_comment_list", {
        id: "a",
      })
      .catch((cause: unknown) => cause);

    expect(refusal).toBeInstanceOf(ActionError);
    expect(refusal).toMatchObject({ reason: "forbidden-surface", status: 403 });
    expect((refusal as ActionError).details()).toEqual({
      personalData: ["freeText"],
    });
    expect(named.handler).not.toHaveBeenCalled();
  });

  it("does not offer it either", async () => {
    const { registry, callers } = withDispatcher([]);

    expect(
      (await registry.list(callers.forPlugin(request(), NOTICEBOARD))).map(
        (one) => one.name,
      ),
    ).toEqual(["news_list"]);
  });

  it("refuses it through a connected app's token on the plugin's route too", async () => {
    // The channel is the app's, but the answer still reaches the plugin.
    const { registry, callers } = withDispatcher([]);
    const read = definition({
      name: "news_comment_read",
      effect: "read",
      surfaces: ["mcp"],
      personalData: ["name"],
    });
    registry.register(read, { kind: "core", module: "news" });

    await expect(
      registry.invoke(
        callers.forPlugin(
          request({
            clientId: "c",
            clientHost: null,
            scopes: ["mcp:read"],
            tokenRowId: "token-c",
          }),
          NOTICEBOARD,
        ),
        "news_comment_read",
        { id: "a" },
      ),
    ).rejects.toMatchObject({ reason: "forbidden-surface" });
    expect(read.handler).not.toHaveBeenCalled();
  });

  it("refuses to hold it as a pending change", async () => {
    const { registry, callers } = withDispatcher([]);
    registry.register(
      definition({
        name: "news_comment_hide",
        surfaces: ["ui"],
        personalData: ["name"],
      }),
      { kind: "core", module: "news" },
    );

    await expect(
      registry.check(
        callers.forPlugin(request(), NOTICEBOARD),
        "news_comment_hide",
        { id: "a" },
      ),
    ).rejects.toMatchObject({ reason: "forbidden-surface" });
  });

  it("dispatches it for a plugin that declared all of it", async () => {
    const { registry, callers } = withDispatcher(["freeText", "name"]);
    const caller = () => callers.forPlugin(request(), NOTICEBOARD);

    await expect(
      registry.invoke(caller(), "news_comment_list", { id: "a" }),
    ).resolves.toEqual({ id: "a" });
    expect((await registry.list(caller())).map((one) => one.name)).toEqual([
      "news_comment_list",
      "news_list",
    ]);
  });

  it("dispatches an action handling none for a plugin that declared none", async () => {
    const { registry, callers } = withDispatcher([]);

    await expect(
      registry.invoke(callers.forPlugin(request(), NOTICEBOARD), "news_list", {
        id: "a",
      }),
    ).resolves.toEqual({ id: "a" });
  });

  describe("for a plugin that asks for site:blocks", () => {
    function withTexts() {
      const built = withDispatcher(["freeText"], true);
      const motions = definition({
        name: "motion_meeting_list",
        group: "motions",
        effect: "read",
        surfaces: ["ui"],
        personalData: ["freeText"],
      });
      const news = definition({
        name: "news_text_list",
        group: "news",
        effect: "read",
        surfaces: ["ui"],
        personalData: ["freeText"],
      });
      built.registry.register(motions, { kind: "core", module: "motions" });
      built.registry.register(news, { kind: "core", module: "news" });
      return { ...built, motions, news };
    }

    it("refuses an action whose free text is not published text, and names it", async () => {
      const { registry, callers, motions } = withTexts();

      const refusal = await registry
        .invoke(
          callers.forPlugin(request(), NOTICEBOARD),
          "motion_meeting_list",
          { id: "a" },
        )
        .catch((cause: unknown) => cause);

      expect(refusal).toBeInstanceOf(ActionError);
      expect(refusal).toMatchObject({
        reason: "forbidden-surface",
        status: 403,
      });
      expect((refusal as ActionError).details()).toEqual({
        personalData: ["freeText"],
      });
      expect(motions.handler).not.toHaveBeenCalled();
    });

    it("dispatches an action of the news group that declares free text", async () => {
      const { registry, callers } = withTexts();

      await expect(
        registry.invoke(
          callers.forPlugin(request(), NOTICEBOARD),
          "news_text_list",
          { id: "a" },
        ),
      ).resolves.toEqual({ id: "a" });
    });

    it("does not offer the other either", async () => {
      const { registry, callers } = withTexts();

      expect(
        (await registry.list(callers.forPlugin(request(), NOTICEBOARD))).map(
          (one) => one.name,
        ),
      ).toEqual(["news_list", "news_text_list"]);
    });

    describe("the board's page actions", () => {
      function pageAction(
        name: string,
        effect: "read" | "write",
        personalData: ("photograph" | "freeText")[],
      ) {
        return definition({
          name,
          group: "pages",
          effect,
          surfaces: ["ui"],
          personalData,
        });
      }

      it("refuses a read that answers with drafts, though it declares no free text", async () => {
        const { registry, callers } = withDispatcher([], true);
        registry.register(pageAction("page_list", "read", []), {
          kind: "core",
          module: "site",
        });

        const refusal = await registry
          .invoke(callers.forPlugin(request(), NOTICEBOARD), "page_list", {
            id: "a",
          })
          .catch((cause: unknown) => cause);

        expect(refusal).toMatchObject({
          reason: "forbidden-surface",
          status: 403,
        });
        expect((refusal as ActionError).details()).toEqual({});
      });

      it("refuses a read of a page's body when the plugin declared photographs", async () => {
        const { registry, callers } = withDispatcher(
          ["freeText", "photograph"],
          true,
        );
        registry.register(pageAction("page_get", "read", ["photograph"]), {
          kind: "core",
          module: "site",
        });

        await expect(
          registry.invoke(
            callers.forPlugin(request(), NOTICEBOARD),
            "page_get",
            { id: "a" },
          ),
        ).rejects.toMatchObject({ reason: "forbidden-surface" });
      });

      it("refuses a write, which answers with the pages it touched", async () => {
        const { registry, callers } = withDispatcher([], true);
        const reorder = pageAction("page_reorder", "write", []);
        registry.register(reorder, { kind: "core", module: "site" });

        await expect(
          registry.invoke(
            callers.forPlugin(request(), NOTICEBOARD),
            "page_reorder",
            { id: "a" },
          ),
        ).rejects.toMatchObject({ reason: "forbidden-surface", status: 403 });
        expect(reorder.handler).not.toHaveBeenCalled();
      });

      it("refuses one that declares free text, though the group is not listed as published", async () => {
        const { registry, callers } = withDispatcher(["freeText"], true);
        registry.register(pageAction("page_text", "read", ["freeText"]), {
          kind: "core",
          module: "site",
        });

        await expect(
          registry.invoke(
            callers.forPlugin(request(), NOTICEBOARD),
            "page_text",
            { id: "a" },
          ),
        ).rejects.toMatchObject({ reason: "forbidden-surface" });
      });

      it("does not offer them", async () => {
        const { registry, callers } = withDispatcher(["photograph"], true);
        registry.register(pageAction("page_list", "read", []), {
          kind: "core",
          module: "site",
        });
        registry.register(pageAction("page_get", "read", ["photograph"]), {
          kind: "core",
          module: "site",
        });
        registry.register(pageAction("page_reorder", "write", []), {
          kind: "core",
          module: "site",
        });

        expect(
          (await registry.list(callers.forPlugin(request(), NOTICEBOARD))).map(
            (one) => one.name,
          ),
        ).toEqual(["news_list"]);
      });

      it("leaves them to a plugin that does not ask for site:blocks", async () => {
        const { registry, callers } = withDispatcher([]);
        registry.register(pageAction("page_list", "read", []), {
          kind: "core",
          module: "site",
        });
        registry.register(pageAction("page_reorder", "write", []), {
          kind: "core",
          module: "site",
        });

        await expect(
          registry.invoke(
            callers.forPlugin(request(), NOTICEBOARD),
            "page_list",
            { id: "a" },
          ),
        ).resolves.toEqual({ id: "a" });
        await expect(
          registry.invoke(
            callers.forPlugin(request(), NOTICEBOARD),
            "page_reorder",
            { id: "a" },
          ),
        ).resolves.toEqual({ id: "a" });
      });

      it("leaves a plugin's own action in a group of that name to it", async () => {
        const { registry, callers, forPerson } = withDispatcher([], true);
        forPerson.mockResolvedValue({
          personId: "person-1",
          capabilities: new Set(["site:manage", "self:manage"]),
        } as unknown as Principal);
        registry.register(
          {
            ...pageAction("noticeboard_pages", "read", []),
            capability: "self:manage",
          },
          { kind: "plugin", pluginId: NOTICEBOARD.id },
        );

        await expect(
          registry.invoke(
            callers.forPlugin(request(), NOTICEBOARD),
            "noticeboard_pages",
            { id: "a" },
          ),
        ).resolves.toEqual({ id: "a" });
      });
    });

    it("leaves a plugin that does not ask for site:blocks its declared free text", async () => {
      const { registry, callers } = withDispatcher(["freeText"]);
      registry.register(
        definition({
          name: "motion_meeting_list",
          group: "motions",
          effect: "read",
          surfaces: ["ui"],
          personalData: ["freeText"],
        }),
        { kind: "core", module: "motions" },
      );

      await expect(
        registry.invoke(
          callers.forPlugin(request(), NOTICEBOARD),
          "motion_meeting_list",
          { id: "a" },
        ),
      ).resolves.toEqual({ id: "a" });
    });
  });

  it("reads a plugin it cannot find as having declared nothing", async () => {
    const { registry, callers } = withDispatcher(["freeText", "name"]);
    const stranger = { id: "stranger", ai: false } as const;

    await expect(
      registry.invoke(
        callers.forPlugin(request(), stranger),
        "news_comment_list",
        { id: "a" },
      ),
    ).rejects.toMatchObject({ reason: "forbidden-surface" });
    expect(
      (await registry.list(callers.forPlugin(request(), stranger))).map(
        (one) => one.name,
      ),
    ).toEqual(["news_list"]);
  });

  it("leaves a person on a session alone", async () => {
    const { registry, callers, lookup } = withDispatcher([]);

    await expect(
      registry.invoke(callers.forRequest(request()), "news_comment_list", {
        id: "a",
      }),
    ).resolves.toEqual({ id: "a" });
    expect(lookup).not.toHaveBeenCalled();
  });
});

/**
 * A plugin whose manifest declares `ai`, dispatching for a signed-in session.
 *
 * The host derives the channel from that declaration, so the cases here are
 * about what the channel then decides: the surface the dispatch reaches, the
 * arming it meets, and what the audit entry the write service is handed says.
 */
describe("what the AI package's dispatch reaches", () => {
  const AI_PACKAGE = { id: "assistant", ai: true } as const;

  /** A handler that keeps the context it was called with. */
  const recordingHandler = () =>
    vi.fn<(input: unknown, context: ActionContext) => Promise<unknown>>(
      async (input) => input,
    );

  /** The context the handler was first called with; fails if it never was. */
  function contextOf(
    handler: ReturnType<typeof recordingHandler>,
  ): ActionContext {
    const call = handler.mock.calls[0];
    if (call === undefined) {
      throw new Error("The handler was never reached.");
    }
    return call[1];
  }

  function withAiPackage(armedActions: readonly string[] = []) {
    const built = build({ capabilities: ["self:manage", "site:manage"] });
    built.registry.register(definition({ name: "news_ui_mcp" }), {
      kind: "core",
      module: "news",
    });
    built.registry.register(
      definition({
        name: "news_offered_to_ai",
        effect: "read",
        surfaces: ["ui", "ai"],
      }),
      { kind: "core", module: "news" },
    );
    built.registry.register(
      definition({
        name: "assistant_summary",
        capability: "self:manage",
        effect: "read",
        surfaces: ["ui", "ai"],
      }),
      { kind: "plugin", pluginId: "assistant" },
    );
    built.registry.bindLiveness({
      get: async () => ({
        serving: true,
        armedActions,
        capabilityFloor: ["self:manage"],
        personalData: [],
        websiteBlocks: false,
      }),
    });
    return built;
  }

  it("is recorded as the AI package, acting as the person who prompted it", async () => {
    // The handler is the write service's door: what it is handed is what the
    // audit entry says. AI, the person, and no connected app.
    const handler = recordingHandler();
    const built = withAiPackage();
    built.registry.register(
      definition({
        name: "news_draft",
        effect: "read",
        surfaces: ["ai"],
        handler,
      }),
      { kind: "core", module: "news" },
    );

    await built.registry.invoke(
      built.callers.forPlugin(request(), AI_PACKAGE),
      "news_draft",
      { id: "a" },
    );

    const context = contextOf(handler);
    expect(context.channel).toBe("ai");
    expect(context.client).toBeUndefined();
    expect(auditActor(actorOf(context))).toEqual({
      channel: "AI",
      actorPersonId: "person-1",
      clientId: null,
      clientHost: null,
      pluginId: "assistant",
      pendingChangeId: null,
    });
  });

  it("is recorded as a plugin's for a plugin that did not declare it", async () => {
    // The same dispatch from a plugin that is no AI package keeps the entry it
    // always had, so the AI value is never a guess about what a plugin is.
    const handler = recordingHandler();
    const built = withAiPackage();
    built.registry.register(
      definition({ name: "news_draft", surfaces: ["ui"], handler }),
      { kind: "core", module: "news" },
    );

    await built.registry.invoke(
      built.callers.forPlugin(request(), { id: "parking", ai: false }),
      "news_draft",
      { id: "a" },
    );

    const context = contextOf(handler);
    expect(auditActor(actorOf(context)).channel).toBe("PLUGIN");
  });

  it("refuses an action not offered on the ai surface, though the product offers it", async () => {
    // The narrowing the declaration buys. As a plain plugin this dispatch would
    // have met the "ui" surface and reached every core action offered there.
    const { registry, callers } = withAiPackage();

    await expect(
      registry.invoke(callers.forPlugin(request(), AI_PACKAGE), "news_ui_mcp", {
        id: "a",
      }),
    ).rejects.toMatchObject({ reason: "forbidden-surface" });
  });

  it("reaches a core action offered on the ai surface", async () => {
    const { registry, callers } = withAiPackage();

    await expect(
      registry.invoke(
        callers.forPlugin(request(), AI_PACKAGE),
        "news_offered_to_ai",
        { id: "a" },
      ),
    ).resolves.toEqual({ id: "a" });
  });

  it("meets the arming for a plugin's action, as a connected app does", async () => {
    // In process, but the model chooses the act, so a plugin's action is
    // reached only once an administrator has armed it.
    const unarmed = withAiPackage([]);
    await expect(
      unarmed.registry.invoke(
        unarmed.callers.forPlugin(request(), AI_PACKAGE),
        "assistant_summary",
        { id: "a" },
      ),
    ).rejects.toMatchObject({ reason: "forbidden-surface" });

    const armed = withAiPackage(["assistant_summary"]);
    await expect(
      armed.registry.invoke(
        armed.callers.forPlugin(request(), AI_PACKAGE),
        "assistant_summary",
        { id: "a" },
      ),
    ).resolves.toEqual({ id: "a" });
  });

  it("lists the ai surface whatever surface it asks for", async () => {
    // A program may not choose its surface, and the AI package is one: asking
    // for "ui" must not hand it the product's own list, nor the plugin
    // actions no administrator armed.
    const { registry, callers } = withAiPackage();
    const caller = callers.forPlugin(request(), AI_PACKAGE);

    for (const surface of [undefined, "ui", "mcp"] as const) {
      expect(
        (
          await registry.list(
            caller,
            surface === undefined ? undefined : { surface },
          )
        ).map((one) => one.name),
      ).toEqual(["news_offered_to_ai"]);
    }
  });

  it("stays a connected app's when a token reaches the AI package's route", async () => {
    // The token's own surface, its arming and its scopes apply, and the entry
    // names the app.
    const handler = recordingHandler();
    const built = withAiPackage();
    built.registry.register(
      definition({ name: "news_draft", surfaces: ["mcp", "ai"], handler }),
      { kind: "core", module: "news" },
    );
    const caller = built.callers.forPlugin(
      request({
        clientId: "client-1",
        clientHost: "claude.ai",
        scopes: ["mcp:write"],
        tokenRowId: "token-client-1",
      }),
      AI_PACKAGE,
    );

    await expect(
      built.registry.invoke(caller, "news_offered_to_ai", { id: "a" }),
    ).rejects.toMatchObject({ reason: "forbidden-surface" });
    await built.registry.invoke(caller, "news_draft", { id: "a" });

    const context = contextOf(handler);
    expect(auditActor(actorOf(context))).toEqual({
      channel: "MCP",
      actorPersonId: "person-1",
      clientId: "client-1",
      clientHost: "claude.ai",
      pluginId: "assistant",
      pendingChangeId: null,
    });
  });
});

/**
 * The schemas a plugin is handed with its listing.
 *
 * What an MCP connector puts in tools/list and what the AI package tells a
 * model. The property that matters is that they are of the listed actions and
 * no others: a schema handed over for an action the caller is refused tells it
 * the action exists, and describes to a model a tool it cannot use.
 */
describe("the schemas a listing carries", () => {
  /**
   * Each action takes a field named after itself, so a schema in the wrong
   * entry, or for an action that was not listed, is visible by its name.
   */
  function named(
    name: string,
    overrides: Partial<ActionDefinition> = {},
  ): ActionDefinition {
    return definition({
      name,
      input: z.strictObject({ [`${name}_in`]: z.string() }),
      output: z.strictObject({ [`${name}_out`]: z.string() }),
      ...overrides,
    });
  }

  function withActions(
    state: { serving: boolean; armedActions: readonly string[] } | null,
  ) {
    const built = build({ capabilities: ["self:manage", "site:manage"] });
    for (const action of [
      named("news_ui", { surfaces: ["ui"] }),
      named("news_mcp", { surfaces: ["mcp"] }),
      named("news_ai", { surfaces: ["ai"] }),
      named("news_everywhere", { surfaces: ["ui", "mcp", "ai"] }),
      named("news_board", {
        surfaces: ["ui", "mcp", "ai"],
        capability: "boardSeat:hold",
      }),
    ]) {
      built.registry.register(action, { kind: "core", module: "news" });
    }
    for (const action of [
      named("assistant_armed", { capability: "self:manage" }),
      named("assistant_unarmed", { capability: "self:manage" }),
    ]) {
      built.registry.register(
        { ...action, surfaces: ["ui", "mcp", "ai"] },
        { kind: "plugin", pluginId: "assistant" },
      );
    }
    built.registry.bindLiveness({
      get: async () =>
        state === null
          ? null
          : {
              ...state,
              capabilityFloor: ["self:manage"],
              personalData: [],
              websiteBlocks: false,
            },
    });
    return built;
  }

  const TOKEN = {
    clientId: "client-1",
    clientHost: "claude.ai",
    scopes: ["mcp:read", "mcp:write"],
    tokenRowId: "token-client-1",
  };

  const callersOf = (built: ReturnType<typeof withActions>) => ({
    "a session": built.callers.forRequest(request()),
    "a connected app": built.callers.forRequest(request(TOKEN)),
    "a plugin": built.callers.forPlugin(request(), {
      id: "parking",
      ai: false,
    }),
    "the AI package": built.callers.forPlugin(request(), {
      id: "assistant",
      ai: true,
    }),
    "a connected app on the AI package's route": built.callers.forPlugin(
      request(TOKEN),
      { id: "assistant", ai: true },
    ),
  });

  it.each([
    ["serving and armed", { serving: true, armedActions: ["assistant_armed"] }],
    ["serving, nothing armed", { serving: true, armedActions: [] }],
    ["not serving", { serving: false, armedActions: ["assistant_armed"] }],
    ["unknown", null],
  ] as const)(
    "lists exactly what list() does for every caller, with the plugin %s",
    async (_, state) => {
      const built = withActions(state);

      for (const [who, caller] of Object.entries(callersOf(built))) {
        const listed = await built.registry.list(caller);
        const described = await built.registry.listWithSchemas(caller);

        expect(described, who).toEqual(
          listed.map((summary) => ({
            ...summary,
            inputSchema: expect.any(Object),
            outputSchema: expect.any(Object),
          })),
        );
      }
    },
  );

  it("hands the AI package the schemas of what it may call and nothing else", async () => {
    // The unarmed plugin action, the actions on other surfaces and the one
    // the person lacks the capability for are all absent, schemas included.
    const built = withActions({
      serving: true,
      armedActions: ["assistant_armed"],
    });

    const described = await built.registry.listWithSchemas(
      built.callers.forPlugin(request(), { id: "assistant", ai: true }),
      { surface: "ui" },
    );

    expect(described.map((one) => one.name)).toEqual([
      "assistant_armed",
      "news_ai",
      "news_everywhere",
    ]);
    const published = JSON.stringify(described);
    for (const absent of [
      "assistant_unarmed",
      "news_ui",
      "news_mcp",
      "news_board",
    ]) {
      expect(published).not.toContain(`"${absent}_in"`);
      expect(published).not.toContain(`"${absent}_out"`);
    }
  });

  it("gives each action its own input and output schema, as the catalogue publishes them", async () => {
    const built = withActions({ serving: true, armedActions: [] });

    const described = await built.registry.listWithSchemas(
      built.callers.forRequest(request()),
    );

    expect(described.length).toBeGreaterThan(0);
    for (const one of described) {
      expect(one.inputSchema).toEqual(built.registry.inputJsonSchema(one.name));
      expect(one.outputSchema).toEqual(
        built.registry.outputJsonSchema(one.name),
      );
      expect(one.inputSchema).toMatchObject({
        type: "object",
        properties: { [`${one.name}_in`]: { type: "string" } },
        required: [`${one.name}_in`],
        additionalProperties: false,
      });
      expect(Object.keys(one.outputSchema.properties as object)).toEqual([
        `${one.name}_out`,
      ]);
    }
  });

  it("lists a write action to a token without mcp:write, which invoke then refuses", async () => {
    // Scope and read-only mode are decided at invoke, not by the listing. This
    // pins the wording of the contract: a listed action may still be refused.
    const built = withActions({ serving: true, armedActions: [] });
    const readOnlyToken = built.callers.forRequest(
      request({ ...TOKEN, scopes: ["mcp:read"] }),
    );

    const described = await built.registry.listWithSchemas(readOnlyToken);

    const listed = described.find((one) => one.name === "news_everywhere");
    expect(listed).toMatchObject({ effect: "write" });
    expect(listed?.inputSchema).toBeDefined();
    await expect(
      built.registry.invoke(readOnlyToken, "news_everywhere", {
        news_everywhere_in: "x",
      }),
    ).rejects.toMatchObject({ reason: "insufficient-scope" });
  });

  it("lists a write action in read-only mode, which invoke then refuses", async () => {
    const built = build({ readOnly: true });
    built.registry.register(definition(), { kind: "core", module: "news" });
    const caller = built.callers.forRequest(request());

    const described = await built.registry.listWithSchemas(caller);

    const listed = described.find((one) => one.name === "news_publish");
    expect(listed).toMatchObject({ effect: "write" });
    expect(listed?.inputSchema).toBeDefined();
    await expect(
      built.registry.invoke(caller, "news_publish", { id: "news-1" }),
    ).rejects.toMatchObject({ reason: "read-only" });
  });

  it("hands schemas that are plain JSON documents", async () => {
    // z.toJSONSchema leaves a non-enumerable ~standard on its root; a copy of
    // the root leaves it behind.
    const built = withActions({ serving: true, armedActions: [] });

    const described = await built.registry.listWithSchemas(
      built.callers.forRequest(request()),
    );

    expect(described.length).toBeGreaterThan(0);
    for (const one of described) {
      expect(Object.getOwnPropertyNames(one.inputSchema)).not.toContain(
        "~standard",
      );
      expect(Object.getOwnPropertyNames(one.outputSchema)).not.toContain(
        "~standard",
      );
    }
  });

  it("hands every listing schemas of its own", async () => {
    // A plugin that edits what it was handed, to trim a description for a
    // model, must not edit what the next caller is handed.
    const built = withActions({ serving: true, armedActions: [] });
    const caller = built.callers.forRequest(request());

    const [first] = await built.registry.listWithSchemas(caller);
    if (first === undefined) {
      expect.unreachable("an action is listed");
    }
    (first.inputSchema.properties as Record<string, unknown>).injected = {
      type: "string",
    };
    const [again] = await built.registry.listWithSchemas(caller);

    expect(again?.name).toBe(first.name);
    expect(again?.inputSchema.properties).not.toHaveProperty("injected");
  });
});

describe("what a published input document may say", () => {
  it("refuses an object that accepts keys it does not declare", async () => {
    // The document a caller reads has to be at least as strict as the write.
    const { registry } = build();

    expect(() =>
      registry.register(definition({ input: z.object({ id: z.string() }) }), {
        kind: "core",
        module: "news",
      }),
    ).toThrow(/accepts keys it does not declare/);
  });

  it("refuses a nested object that does, which is the half that gets missed", async () => {
    const { registry } = build();

    expect(() =>
      registry.register(
        definition({
          input: z.strictObject({ page: z.object({ slug: z.string() }) }),
        }),
        { kind: "core", module: "news" },
      ),
    ).toThrow(/page/);
  });

  it("refuses a loose branch inside a discriminated union", async () => {
    // Menu entries are a union on kind, so this is the shape the first slice
    // actually uses.
    const { registry } = build();

    expect(() =>
      registry.register(
        definition({
          input: z.strictObject({
            target: z.discriminatedUnion("kind", [
              z.strictObject({ kind: z.literal("PAGE"), pageId: z.string() }),
              z.object({ kind: z.literal("EXTERNAL"), url: z.string() }),
            ]),
          }),
        }),
        { kind: "core", module: "site" },
      ),
    ).toThrow(/target/);
  });

  it("refuses a loose object inside an array", async () => {
    const { registry } = build();

    expect(() =>
      registry.register(
        definition({
          input: z.strictObject({
            blocks: z.array(z.object({ text: z.string() })),
          }),
        }),
        { kind: "core", module: "site" },
      ),
    ).toThrow(/blocks.items/);
  });

  it("refuses a loose object inside a tuple, which publishes no items", () => {
    /*
     * A tuple emits `prefixItems` and sets `items` to false, so the member
     * schemas sit where neither the properties walk nor the items walk looks.
     */
    const { registry } = build();

    expect(() =>
      registry.register(
        definition({
          input: z.strictObject({
            span: z.tuple([z.object({ from: z.string() })]),
          }),
        }),
        { kind: "core", module: "site" },
      ),
    ).toThrow(/span.prefixItems\[0]/);
  });

  it("refuses a loose object inside a record, which declares no properties", () => {
    /*
     * A record publishes its value schema as `additionalProperties` and no
     * `properties` at all, so the strictness check skips the record itself and
     * the value schema was reached from nowhere.
     */
    const { registry } = build();

    expect(() =>
      registry.register(
        definition({
          input: z.strictObject({
            byLocale: z.record(z.string(), z.object({ title: z.string() })),
          }),
        }),
        { kind: "core", module: "site" },
      ),
    ).toThrow(/byLocale.additionalProperties/);
  });

  it("accepts one that is strict all the way down", () => {
    const { registry } = build();

    expect(() =>
      registry.register(
        definition({
          input: z.strictObject({
            page: z.strictObject({ slug: z.string() }),
            blocks: z.array(z.strictObject({ text: z.string() })),
          }),
        }),
        { kind: "core", module: "site" },
      ),
    ).not.toThrow();
  });
});

/**
 * A caller on the `ai` channel.
 *
 * Nothing in core mints one yet: the channel is derived for a plugin's dispatch
 * by a later change (ADR 0038). The refusal below is written now so that the
 * day it is minted, a model's write is already held rather than run, so the
 * handle is planted in the factory's own record for the test.
 */
function aiCaller(callers: ActionCallerFactory) {
  const caller = callers.forRequest(request());
  const record = (
    callers as unknown as {
      minted: WeakMap<object, Record<string, unknown>>;
    }
  ).minted;
  record.set(caller, { ...record.get(caller), channel: "ai" });
  return caller;
}

describe("what is held as a pending change rather than run (ADR 0039)", () => {
  it("refuses a write on the ai channel, before the capability is read", async () => {
    const { registry, callers, forPerson } = build();
    const held = definition({ surfaces: ["ui", "ai"] });
    registry.register(held, { kind: "core", module: "news" });

    await expect(
      registry.invoke(aiCaller(callers), "news_publish", { id: "news-1" }),
    ).rejects.toMatchObject({ reason: "confirmation-required", status: 409 });
    expect(forPerson).not.toHaveBeenCalled();
    expect(held.handler).not.toHaveBeenCalled();
  });

  it("lets a read through on the ai channel", async () => {
    const { registry, callers } = build();
    registry.register(definition({ effect: "read", surfaces: ["ui", "ai"] }), {
      kind: "core",
      module: "news",
    });

    await expect(
      registry.invoke(aiCaller(callers), "news_publish", { id: "news-1" }),
    ).resolves.toEqual({ id: "news-1" });
  });

  it("checks a proposal as it would check the call, without running it", async () => {
    const { registry, callers, forPerson } = build();
    const held = definition({ deprecatedAliases: ["news_post"] });
    registry.register(held, { kind: "core", module: "news" });

    const checked = await registry.check(
      callers.forPlugin(request(), { id: "parking", ai: false }),
      "news_post",
      { id: "news-1" },
    );

    // The canonical definition, so the proposal is stored under the name and
    // not the alias it arrived by.
    expect(checked.definition.name).toBe("news_publish");
    expect(checked.value).toEqual({ id: "news-1" });
    expect(forPerson).toHaveBeenCalledTimes(1);
    expect(held.handler).not.toHaveBeenCalled();
  });

  it("lets the ai channel propose the write it may not run", async () => {
    const { registry, callers } = build();
    registry.register(definition({ surfaces: ["ui", "ai"] }), {
      kind: "core",
      module: "news",
    });

    await expect(
      registry.check(aiCaller(callers), "news_publish", { id: "news-1" }),
    ).resolves.toMatchObject({ value: { id: "news-1" } });
  });

  it("refuses to hold a read, which has nothing to confirm", async () => {
    const { registry, callers } = build();
    registry.register(definition({ effect: "read" }), {
      kind: "core",
      module: "news",
    });

    await expect(
      registry.check(
        callers.forPlugin(request(), { id: "parking", ai: false }),
        "news_publish",
        {
          id: "news-1",
        },
      ),
    ).rejects.toMatchObject({ reason: "forbidden-surface" });
  });

  it("refuses to hold what the platform's own screens could never confirm", async () => {
    // Confirming dispatches as the person on `web`, which reaches the `ui`
    // surface; an action offered only to the AI package could never run.
    const { registry, callers } = build();
    registry.register(definition({ surfaces: ["ai"] }), {
      kind: "core",
      module: "news",
    });

    await expect(
      registry.check(aiCaller(callers), "news_publish", { id: "news-1" }),
    ).rejects.toMatchObject({ reason: "forbidden-surface" });
  });

  it("refuses a proposal the proposer could not make themselves", async () => {
    const { registry, callers } = build({ capabilities: ["self:manage"] });
    registry.register(definition(), { kind: "core", module: "news" });

    await expect(
      registry.check(
        callers.forPlugin(request(), { id: "parking", ai: false }),
        "news_publish",
        {
          id: "news-1",
        },
      ),
    ).rejects.toMatchObject({ reason: "forbidden-capability" });
  });

  it("refuses an input the action's schema refuses when it is proposed", async () => {
    const { registry, callers } = build();
    registry.register(definition(), { kind: "core", module: "news" });

    await expect(
      registry.check(
        callers.forPlugin(request(), { id: "parking", ai: false }),
        "news_publish",
        {
          id: "news-1",
          extra: true,
        },
      ),
    ).rejects.toBeInstanceOf(ZodError);
  });

  it("carries the pending change it confirms to the handler", async () => {
    const { registry, callers } = build();
    const held = definition();
    registry.register(held, { kind: "core", module: "news" });

    await registry.invoke(
      callers.forConfirmation(request(), {
        id: "pending-1",
        proposedOn: "plugin",
      }),
      "news_publish",
      { id: "news-1" },
    );

    expect(held.handler).toHaveBeenCalledWith(
      { id: "news-1" },
      expect.objectContaining({ channel: "web", pendingChangeId: "pending-1" }),
    );
  });

  it("will not mint a confirmation for a request carrying a token", () => {
    const { callers } = build();

    expect(() =>
      callers.forConfirmation(
        request({
          clientId: "c",
          clientHost: null,
          scopes: ["mcp:write"],
          tokenRowId: "token-c",
        }),
        { id: "pending-1", proposedOn: "mcp" },
      ),
    ).toThrow(/web interface/);
  });

  it("claims a held call after every check and before the handler", async () => {
    const { registry, callers } = build();
    const order: string[] = [];
    const held = definition({
      handler: vi.fn(async (input: unknown) => {
        order.push("handler");
        return input;
      }),
    });
    registry.register(held, { kind: "core", module: "news" });

    await registry.invokeHeld(
      callers.forConfirmation(request(), {
        id: "pending-1",
        proposedOn: "plugin",
      }),
      "news_publish",
      { id: "news-1" },
      async () => {
        order.push("claim");
      },
    );

    expect(order).toEqual(["claim", "handler"]);
  });

  it("does not claim a held call a check refuses", async () => {
    // So a refused confirmation leaves the change waiting, untouched.
    const { registry, callers } = build({ capabilities: ["self:manage"] });
    const held = definition();
    registry.register(held, { kind: "core", module: "news" });
    const claim = vi.fn(async () => undefined);

    await expect(
      registry.invokeHeld(
        callers.forConfirmation(request(), {
          id: "pending-1",
          proposedOn: "plugin",
        }),
        "news_publish",
        { id: "news-1" },
        claim,
      ),
    ).rejects.toMatchObject({ reason: "forbidden-capability" });
    expect(claim).not.toHaveBeenCalled();
    expect(held.handler).not.toHaveBeenCalled();
  });

  it("runs nothing when the claim is refused", async () => {
    // A second press that lost the race to the first.
    const { registry, callers } = build();
    const held = definition();
    registry.register(held, { kind: "core", module: "news" });

    await expect(
      registry.invokeHeld(
        callers.forConfirmation(request(), {
          id: "pending-1",
          proposedOn: "plugin",
        }),
        "news_publish",
        { id: "news-1" },
        async () => {
          throw new Error("taken");
        },
      ),
    ).rejects.toThrow("taken");
    expect(held.handler).not.toHaveBeenCalled();
  });
});

/**
 * Arming, asked again when a change proposed beyond this instance is confirmed.
 *
 * The confirmation runs on `web`, where a serving plugin's action needs no
 * arming at all. What an app or a model proposed reached the action only
 * because an administrator had armed it, so disarming it has to stop the
 * confirmation too (ADR 0039, §3).
 */
describe("what a held call is to, and what it is held to (CoreActionDefinition)", () => {
  /** A core action naming a news item, whose read answers with `facts`. */
  function targeted(
    facts: readonly ActionTargetFact[] | null,
  ): CoreActionDefinition {
    return {
      ...definition(),
      target: {
        kind: "news",
        id: (input) => (input as { id: string }).id,
        read: vi.fn(async () => facts),
      },
    };
  }

  it("reads the target for a reader who may still act on it", async () => {
    const { registry } = build();
    registry.register(
      targeted([{ fact: "status", now: "DRAFT", after: "PUBLISHED" }]),
      { kind: "core", module: "news" },
    );

    await expect(
      registry.targetOf("news_publish", { id: "news-1" }, "person-1"),
    ).resolves.toEqual({
      kind: "news",
      id: "news-1",
      state: "found",
      facts: [{ fact: "status", now: "DRAFT", after: "PUBLISHED" }],
    });
  });

  it("says the target is gone when nothing answers to the id", async () => {
    const { registry } = build();
    registry.register(targeted(null), { kind: "core", module: "news" });

    await expect(
      registry.targetOf("news_publish", { id: "news-1" }, "person-1"),
    ).resolves.toMatchObject({ state: "missing", facts: [] });
  });

  it("shows nothing of the target to a reader without the capability now", async () => {
    // A draft, or a members-only page, is shown only to somebody who may still
    // act on it: the proposer's grant when they proposed is not enough.
    const { registry } = build({ capabilities: [] });
    const action = targeted([
      { fact: "title", now: "Styrelsens anteckningar" },
    ]);
    registry.register(action, { kind: "core", module: "news" });

    await expect(
      registry.targetOf("news_publish", { id: "news-1" }, "person-1"),
    ).resolves.toEqual({
      kind: "news",
      id: "news-1",
      state: "withheld",
      facts: [],
    });
    expect(action.target?.read).not.toHaveBeenCalled();
  });

  it("has none for an action that declares none, or one nothing answers to", async () => {
    const { registry } = build();
    registry.register(definition(), { kind: "core", module: "news" });

    await expect(
      registry.targetOf("news_publish", { id: "news-1" }, "person-1"),
    ).resolves.toBeNull();
    await expect(
      registry.targetOf("news_gone", { id: "news-1" }, "person-1"),
    ).resolves.toBeNull();
  });

  it("keeps neither a target nor a proposal rule that a plugin's definition carries", async () => {
    // Both would run the plugin's code outside a dispatch, and what the
    // preview says about a target is the platform's statement.
    const { registry, callers } = build();
    const checkProposed = vi.fn(() => [{ path: ["id"], message: "No." }]);
    registry.register(
      {
        ...targeted([{ fact: "title", now: "Inte sant" }]),
        name: "parking_publish",
        checkProposed,
      },
      { kind: "plugin", pluginId: "parking" },
    );
    registry.bindLiveness({
      get: async () => ({
        serving: true,
        armedActions: [],
        capabilityFloor: [],
        personalData: [],
        websiteBlocks: false,
      }),
    });

    await expect(
      registry.targetOf("parking_publish", { id: "news-1" }, "person-1"),
    ).resolves.toBeNull();
    await expect(
      registry.check(
        callers.forPlugin(request(), { id: "parking", ai: false }),
        "parking_publish",
        { id: "news-1" },
      ),
    ).resolves.toMatchObject({ value: { id: "news-1" } });
    expect(checkProposed).not.toHaveBeenCalled();
  });

  it("refuses a proposal its rule refuses, as the schema would, and lets the call itself through", async () => {
    const { registry, callers } = build();
    const action: CoreActionDefinition = {
      ...definition(),
      checkProposed: () => [{ path: ["id"], message: "Not when held." }],
    };
    registry.register(action, { kind: "core", module: "news" });
    const caller = callers.forPlugin(request(), { id: "parking", ai: false });

    const refused = await registry
      .check(caller, "news_publish", { id: "news-1" })
      .then(
        () => null,
        (cause: unknown) => cause,
      );
    expect(refused).toBeInstanceOf(ZodError);
    expect((refused as ZodError).issues.map((issue) => issue.path)).toEqual([
      ["id"],
    ]);

    await expect(
      registry.invoke(caller, "news_publish", { id: "news-1" }),
    ).resolves.toEqual({ id: "news-1" });
  });
});

describe("confirming a change proposed through a connected app", () => {
  function withPlugin(armedActions: readonly string[]) {
    const built = build({ capabilities: ["self:manage", "site:manage"] });
    const held = definition({ name: "occupancy_note" });
    built.registry.register(held, { kind: "plugin", pluginId: "occupancy" });
    built.registry.bindLiveness({
      get: async () => ({
        serving: true,
        armedActions,
        capabilityFloor: ["self:manage"],
        personalData: [],
        websiteBlocks: false,
      }),
    });
    return { ...built, held };
  }

  it("is refused once an administrator has disarmed the action", async () => {
    const { registry, callers, held } = withPlugin([]);

    await expect(
      registry.invoke(
        callers.forConfirmation(request(), {
          id: "pending-1",
          proposedOn: "mcp",
        }),
        "occupancy_note",
        { id: "a" },
      ),
    ).rejects.toMatchObject({ reason: "forbidden-surface" });
    expect(held.handler).not.toHaveBeenCalled();
  });

  it("runs while the action is still armed, as the confirming person on web", async () => {
    const { registry, callers, held } = withPlugin(["occupancy_note"]);

    await registry.invoke(
      callers.forConfirmation(request(), {
        id: "pending-1",
        proposedOn: "mcp",
      }),
      "occupancy_note",
      { id: "a" },
    );

    expect(held.handler).toHaveBeenCalledWith(
      { id: "a" },
      expect.objectContaining({ channel: "web" }),
    );
  });

  it("is refused once the action is no longer offered where it was proposed", async () => {
    // A model's proposal, for an action whose plugin now offers it only in
    // process: armed or not, the AI package could no longer reach it.
    const { registry, callers, held } = withPlugin(["occupancy_note"]);

    await expect(
      registry.invoke(
        callers.forConfirmation(request(), {
          id: "pending-1",
          proposedOn: "ai",
        }),
        "occupancy_note",
        { id: "a" },
      ),
    ).rejects.toMatchObject({ reason: "forbidden-surface" });
    expect(held.handler).not.toHaveBeenCalled();
  });

  it("needs no arming for a change a plugin's own route proposed", async () => {
    // The route reached it in process, where arming governs nothing.
    const { registry, callers } = withPlugin([]);

    await expect(
      registry.invoke(
        callers.forConfirmation(request(), {
          id: "pending-1",
          proposedOn: "plugin",
        }),
        "occupancy_note",
        { id: "a" },
      ),
    ).resolves.toEqual({ id: "a" });
  });
});

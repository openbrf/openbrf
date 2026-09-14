import type { ActionDefinition } from "@openbrf/plugin-sdk";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import type { Principal } from "../authorization/capabilities";
import type { PrincipalService } from "../authorization/principal.service";
import type { Env } from "../config/env";
import type { I18nService } from "../i18n/i18n.service";
import { ActionCallerFactory, type RequestWithToken } from "./action-caller";
import { ActionRegistryService } from "./action-registry.service";
import { markAuthenticated } from "./authenticated-request";

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
  markAuthenticated(held);
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

describe("what a plugin's action depends on", () => {
  const pluginAction = () =>
    definition({ name: "occupancy_summary", capability: "self:manage" });

  function withPlugin(
    state: {
      serving: boolean;
      armedActions: readonly string[];
      capabilityFloor: string;
    } | null,
  ) {
    const built = build({ capabilities: ["self:manage", "site:manage"] });
    built.registry.register(pluginAction(), {
      kind: "plugin",
      pluginId: "occupancy",
    });
    built.registry.bindLiveness({ get: async () => state });
    return built;
  }

  it("is unreachable while the plugin is not serving", async () => {
    const { registry, callers } = withPlugin({
      serving: false,
      armedActions: ["occupancy_summary"],
      capabilityFloor: "self:manage",
    });

    await expect(
      registry.invoke(callers.forRequest(request()), "occupancy_summary", {
        id: "a",
      }),
    ).rejects.toMatchObject({ reason: "forbidden-surface" });
  });

  it("is unreachable through a connected app until an administrator arms it", async () => {
    // Declaring an action is a proposal; arming it is the act that exposes it.
    const { registry, callers } = withPlugin({
      serving: true,
      armedActions: [],
      capabilityFloor: "self:manage",
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
      capabilityFloor: "self:manage",
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
      capabilityFloor: "self:manage",
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
      capabilityFloor: "self:manage",
    });

    const inProcess = callers.forPlugin(request());
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
      capabilityFloor: "self:manage",
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
        capabilityFloor: "self:manage",
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
      capabilityFloor: "addressBook:read",
    });

    await expect(
      registry.invoke(callers.forRequest(request()), "occupancy_summary", {
        id: "a",
      }),
    ).rejects.toMatchObject({ reason: "forbidden-capability" });
  });

  it("disappears with the plugin", async () => {
    const { registry, callers } = withPlugin({
      serving: true,
      armedActions: ["occupancy_summary"],
      capabilityFloor: "self:manage",
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

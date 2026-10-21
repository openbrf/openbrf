import { Logger } from "@nestjs/common";
import type {
  ActionContext,
  ActionDefinition,
  ActionErrorSpec,
  PluginManifest,
  PluginPermission,
} from "@openbrf/plugin-sdk";
import {
  ACTION_ERROR_MCP,
  ACTION_ERROR_REASONS,
  isActionRefusal,
  PLUGIN_FINANCE_EVENTS,
  PluginHostUnavailableError,
  PluginPermissionError,
} from "@openbrf/plugin-sdk";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import { ActionCallerFactory } from "../actions/action-caller";
import type { ActionCaller } from "../actions/action-caller";
import { ActionRegistryService } from "../actions/action-registry.service";
import { ActionError } from "../actions/action.error";
import { actorOf } from "../actions/actor-of";
import { markAuthenticated } from "../actions/authenticated-request";
import { auditActor } from "../audit/actor-context";
import type { RequestToken } from "../authorization/authorization.guard";
import type { PrincipalService } from "../authorization/principal.service";
import type { Env } from "../config/env";
import { DomainError } from "../http/domain-error";
import type { I18nService } from "../i18n/i18n.service";
import {
  createPluginHost,
  PluginHostBinding,
  type PluginHostContext,
  type PluginHostServices,
  routeCapabilityFloor,
} from "./plugin-host";

/**
 * The capability floor for a plugin's own routes.
 *
 * A plugin route is reached through the application's own guard, so the caller
 * is already authenticated; the floor decides how much more than that is
 * required. It is derived from the plugin's data permissions rather than taken
 * from the route's own declaration, because a plugin that can read the register
 * must not be able to expose that reading through a route it declared open to
 * any resident - by mistake or otherwise. Consent to a plugin reading contact
 * details is not consent to every resident reading them through it.
 *
 * The floor is raised, never lowered: a route asking for more than its plugin's
 * permissions imply keeps what it asked for, which is why this returns a
 * minimum and not a final answer.
 */

describe("routeCapabilityFloor", () => {
  it("requires no more than an authenticated caller when nothing was granted", () => {
    // self:manage is what any account holds, so a plugin that reads nothing
    // from the register is not gated beyond the guard that already ran.
    expect(routeCapabilityFloor([])).toEqual(["self:manage"]);
  });

  it.each<PluginPermission>(["addressBook:read", "addressBook:readContact"])(
    "raises the floor to addressBook:read for a plugin holding %s",
    (permission) => {
      // Both permissions reach register data that is board-only in the core
      // product, so both put the plugin's routes behind the same capability the
      // core requires to read it.
      expect(routeCapabilityFloor([permission])).toEqual(["addressBook:read"]);
    },
  );

  it("raises the floor for a plugin holding both address book permissions", () => {
    expect(
      routeCapabilityFloor(["addressBook:read", "addressBook:readContact"]),
    ).toEqual(["addressBook:read"]);
  });

  it("does not raise the floor for a permission that reads no register data", () => {
    // Sending mail, sending SMS and running jobs reach nothing the caller of a
    // route could read back, so gating those routes above self:manage would
    // lock residents out of plugins written for them. Recording a delivery
    // receipt writes a note against an id and reads no row either.
    expect(routeCapabilityFloor(["mail:send"])).toEqual(["self:manage"]);
    expect(routeCapabilityFloor(["sms:send"])).toEqual(["self:manage"]);
    expect(routeCapabilityFloor(["jobs:schedule"])).toEqual(["self:manage"]);
    expect(routeCapabilityFloor(["finances:recordDelivery"])).toEqual([
      "self:manage",
    ]);
    expect(
      routeCapabilityFloor(["mail:send", "sms:send", "jobs:schedule"]),
    ).toEqual(["self:manage"]);
  });

  it("raises the floor when a register permission sits among others", () => {
    expect(
      routeCapabilityFloor([
        "mail:send",
        "jobs:schedule",
        "addressBook:readContact",
      ]),
    ).toEqual(["addressBook:read"]);
  });

  it("puts a plugin reading the finances behind both of the board's money capabilities", () => {
    // finances:read reads the notices and the charges alike, so a caller
    // holding one of the two capabilities would otherwise read the other half
    // through the plugin.
    expect(routeCapabilityFloor(["finances:read"])).toEqual([
      "fees:manage",
      "memberCharges:manage",
    ]);
  });

  it("requires every floor a plugin's permissions imply, not one of them", () => {
    expect(
      routeCapabilityFloor([
        "finances:read",
        "finances:recordDelivery",
        "addressBook:read",
      ]),
    ).toEqual(["addressBook:read", "fees:manage", "memberCharges:manage"]);
  });
});

/**
 * The late-bound host object.
 *
 * A plugin's module factory runs before the application exists, so what it
 * receives resolves its services on use rather than on construction. Two
 * moments have to refuse rather than answer with something half-built or
 * something the plugin is no longer entitled to: before the application has
 * been bound, and after the board has switched the plugin off.
 */

const MANIFEST: PluginManifest = {
  apiVersion: 1,
  id: "occupancy",
  entry: { server: "./dist/server.cjs" },
  permissions: ["addressBook:read"],
  personalData: ["name"],
  actions: [],
  ai: false,
  blocks: [],
};

/**
 * A double for each application service, with the address book and the SMS
 * service spied on.
 */
function services(): {
  bound: PluginHostServices;
  residents: ReturnType<typeof vi.fn>;
  sms: ReturnType<typeof vi.fn>;
} {
  const residents = vi.fn(async () => []);
  const sms = vi.fn(async () => undefined);
  return {
    residents,
    sms,
    bound: {
      registry: { find: vi.fn(async () => null) },
      jobs: { send: vi.fn(async () => undefined) },
      mail: { send: vi.fn(async () => undefined) },
      sms: { send: sms },
      addressBook: {
        summary: vi.fn(async () => ({
          apartments: 1,
          residents: 2,
          members: 3,
        })),
        residents,
        apartments: vi.fn(async () => []),
      },
    } as unknown as PluginHostServices,
  };
}

describe("the late-bound host object", () => {
  let binding: PluginHostBinding;
  let context: PluginHostContext;

  beforeEach(() => {
    binding = new PluginHostBinding();
    context = {
      manifest: MANIFEST,
      consented: ["addressBook:read"],
      serving: true,
      bufferedActions: [],
      bufferedBlocks: [],
    };
  });

  it("refuses a service used before the application has started", async () => {
    // What a plugin doing work in a provider's constructor would hit. Named
    // rather than surfacing as a null dereference, because the fix is to move
    // the call to onModuleInit and nothing else says so.
    const host = createPluginHost(binding, context);

    await expect(host.addressBook.summary()).rejects.toBeInstanceOf(
      PluginHostUnavailableError,
    );
  });

  it("logs before the application has started, naming the plugin", () => {
    // The one service that must work at any moment, including from the
    // constructor that is about to fail. Asserted on what reaches the log
    // rather than on the absence of a throw: a logger that quietly dropped the
    // line would satisfy "did not throw" while leaving an operator with no way
    // to tell which plugin produced it, or that it produced anything.
    const emitted = vi
      .spyOn(Logger.prototype, "log")
      .mockImplementation(() => undefined);
    try {
      createPluginHost(binding, context).logger.info("starting");

      expect(emitted).toHaveBeenCalledWith("starting");
      const [instance] = emitted.mock.contexts as {
        context?: string;
      }[];
      expect(instance?.context).toBe(`plugin:${MANIFEST.id}`);
    } finally {
      emitted.mockRestore();
    }
  });

  /**
   * addressBook:readContact is the wider of the two register permissions - it
   * adds email and phone to the same rows - and the manifest schema accepts it
   * on its own. A plugin declaring only that must therefore not be refused the
   * reads addressBook:read would have allowed.
   */
  it("accepts addressBook:readContact on its own for every register read", async () => {
    const { bound, residents } = services();
    binding.bind(bound);
    const host = createPluginHost(binding, {
      ...context,
      manifest: { ...MANIFEST, permissions: ["addressBook:readContact"] },
      consented: ["addressBook:readContact"],
    });

    await expect(host.addressBook.summary()).resolves.toEqual({
      apartments: 1,
      residents: 2,
      members: 3,
    });
    await expect(host.addressBook.apartments()).resolves.toEqual([]);
    await expect(host.addressBook.residents()).resolves.toEqual([]);
    expect(residents).toHaveBeenCalledWith({ contact: true });
  });

  it("answers once the application has bound its services", async () => {
    const host = createPluginHost(binding, context);
    binding.bind(services().bound);

    await expect(host.addressBook.summary()).resolves.toEqual({
      apartments: 1,
      residents: 2,
      members: 3,
    });
  });

  /**
   * Switching a plugin off has to reach further than its routes. Its code
   * stays in this process until the next boot, so a timer or a job worker it
   * started is still running - and must no longer be able to read the register
   * or send mail as the association.
   */
  it("refuses every service once the plugin stops serving", async () => {
    const host = createPluginHost(binding, context);
    binding.bind(services().bound);
    context.serving = false;

    await expect(host.addressBook.summary()).rejects.toBeInstanceOf(
      PluginHostUnavailableError,
    );
    await expect(host.settings.read()).rejects.toBeInstanceOf(
      PluginHostUnavailableError,
    );
  });

  /**
   * The job queue refuses a name outside `[A-Za-z0-9_.\-/]`, the rule pg-boss
   * applies in `createQueue`. A `:` in the prefix failed every call.
   */
  it("names a plugin's queue in characters the job queue accepts", async () => {
    const { bound } = services();
    binding.bind(bound);
    const host = createPluginHost(binding, {
      ...context,
      consented: ["jobs:schedule"],
    });
    const send = vi.spyOn(bound.jobs, "send");

    await host.jobs.send("nightly", { at: 1 });

    expect(send).toHaveBeenCalledWith("plugin/occupancy/nightly", {
      at: 1,
    });
    await expect(host.jobs.send("a:b", {})).rejects.toBeInstanceOf(RangeError);
    await expect(host.jobs.send("../x", {})).rejects.toBeInstanceOf(RangeError);
  });

  it("leaves a refused queue name out of the error, where it could be personal data", async () => {
    const { bound } = services();
    binding.bind(bound);
    const host = createPluginHost(binding, {
      ...context,
      consented: ["jobs:schedule"],
    });

    const refused = await host.jobs
      .send("anna@example.test", {})
      .catch((cause: unknown) => cause);

    expect(refused).toBeInstanceOf(RangeError);
    expect((refused as RangeError).message).not.toContain("anna");
  });

  it("refuses a service the manifest did not declare", async () => {
    const host = createPluginHost(binding, context);
    binding.bind(services().bound);

    await expect(
      host.mail.send({ to: "a@exempel.se", subject: "x", text: "y" }),
    ).rejects.toBeInstanceOf(PluginPermissionError);
    await expect(host.jobs.send("nightly", { at: 1 })).rejects.toBeInstanceOf(
      PluginPermissionError,
    );
  });

  /**
   * SMS is its own permission, so consent to mail is not consent to send a
   * text message. The two are declared apart because they cost the housing
   * cooperative different things: a text message is billed per message against
   * a provider contract the board signed, and a board that agreed to a plugin
   * writing to its members has not thereby agreed to it spending that contract.
   */
  it("refuses a text message from a plugin that declared only mail", async () => {
    const { bound, sms } = services();
    binding.bind(bound);
    const host = createPluginHost(binding, {
      ...context,
      consented: ["mail:send"],
    });

    await expect(
      host.sms.send({ to: "+46701234567", text: "y" }),
    ).rejects.toBeInstanceOf(PluginPermissionError);
    expect(sms).not.toHaveBeenCalled();
  });

  it("sends a text message for a plugin that declared sms:send", async () => {
    const { bound, sms } = services();
    binding.bind(bound);
    const host = createPluginHost(binding, {
      ...context,
      consented: ["sms:send"],
    });

    await expect(
      host.sms.send({ to: "+46701234567", text: "Portkoden byts imorgon." }),
    ).resolves.toBeUndefined();

    // The body as the plugin wrote it, and no sender: which name a message
    // presents is the housing cooperative's provider contract, applied by the
    // SMS service, and never a plugin's to choose.
    expect(sms).toHaveBeenCalledWith({
      to: "+46701234567",
      body: "Portkoden byts imorgon.",
    });
  });

  /**
   * An instance with no SMS provider cannot send, and the send fails rather
   * than being dropped. That decision belongs to the SMS service and is taken
   * once for every caller in the application, so the host passes the failure
   * through instead of answering for it a second way.
   */
  it("passes on what the SMS service refuses", async () => {
    const { bound, sms } = services();
    const refusal = new Error("This instance has no SMS provider.");
    sms.mockRejectedValueOnce(refusal);
    binding.bind(bound);
    const host = createPluginHost(binding, {
      ...context,
      consented: ["sms:send"],
    });

    await expect(host.sms.send({ to: "+46701234567", text: "y" })).rejects.toBe(
      refusal,
    );
  });

  /**
   * The serving check runs ahead of the permission gate, so a plugin that was
   * switched off is told that rather than being told about a permission it was
   * never going to be allowed to use either way.
   */
  it("reports being switched off before reporting a missing permission", async () => {
    const host = createPluginHost(binding, context);
    binding.bind(services().bound);
    context.serving = false;

    await expect(
      host.mail.send({ to: "a@exempel.se", subject: "x", text: "y" }),
    ).rejects.toBeInstanceOf(PluginHostUnavailableError);
  });

  it("asks the address book for contact details only when they were consented to", async () => {
    const { bound, residents } = services();
    binding.bind(bound);

    await createPluginHost(binding, context).addressBook.residents();
    await createPluginHost(binding, {
      ...context,
      consented: ["addressBook:read", "addressBook:readContact"],
    }).addressBook.residents();

    // Decided by the host from the consented set, never by the caller: the
    // contact fields are a second permission, not a parameter.
    expect(residents).toHaveBeenNthCalledWith(1, { contact: false });
    expect(residents).toHaveBeenNthCalledWith(2, { contact: true });
  });

  it("proposes as the person whose request the plugin serves, and links to the preview", async () => {
    const { bound } = services();
    const caller = {};
    const forPlugin = vi.fn(() => caller);
    const propose = vi.fn(async () => ({
      id: "pending-1",
      expiresAt: new Date("2026-10-27T12:00:00Z"),
    }));
    binding.bind({
      ...bound,
      callers: { forPlugin },
      pendingChanges: { propose },
    } as unknown as PluginHostServices);
    const request = { id: "req-1" };

    const receipt = await createPluginHost(binding, context).actions.propose(
      request,
      "page_update",
      { id: "page-1" },
    );

    // The person comes from the request the host authenticated, never from
    // an argument, exactly as for invoke.
    expect(forPlugin).toHaveBeenCalledWith(request, { ai: false });
    expect(propose).toHaveBeenCalledWith(caller, "page_update", {
      id: "page-1",
    });
    expect(receipt).toEqual({
      id: "pending-1",
      expiresAt: new Date("2026-10-27T12:00:00Z"),
      path: "/app/pending-changes/pending-1",
    });
  });
});

/**
 * The channel a plugin's dispatch is recorded on.
 *
 * Derived by the host from the manifest the board consented to and from how
 * the request arrived. The plugin's own code passes a request, a name and an
 * input, and none of them can move it onto another channel.
 */
describe("the channel a plugin dispatches through", () => {
  function dispatching(manifest: PluginManifest) {
    const callers = new ActionCallerFactory();
    const seen: ActionCaller[] = [];
    const actions = {
      invoke: vi.fn(async (caller: ActionCaller) => {
        seen.push(caller);
        return {};
      }),
      listWithSchemas: vi.fn(async (caller: ActionCaller) => {
        seen.push(caller);
        return [];
      }),
    } as unknown as ActionRegistryService;
    const binding = new PluginHostBinding();
    binding.bind({ ...services().bound, actions, callers });
    const host = createPluginHost(binding, {
      manifest,
      consented: [],
      serving: true,
      bufferedActions: [],
      bufferedBlocks: [],
    });
    const channels = () =>
      seen.map((caller) => callers.resolve(caller).channel);
    return { host, channels };
  }

  function sessionRequest() {
    const held = { id: "req-1", principal: { personId: "person-1" } };
    markAuthenticated(held, {
      personId: "person-1",
      token: null,
      requestId: "req-1",
    });
    return held;
  }

  it("is the AI package's for a plugin whose manifest declares it", async () => {
    const { host, channels } = dispatching({ ...MANIFEST, ai: true });

    await host.actions.invoke(sessionRequest() as never, "news_draft", {});
    await host.actions.list(sessionRequest() as never);

    expect(channels()).toEqual(["ai", "ai"]);
  });

  it("is a plugin's for one whose manifest does not", async () => {
    const { host, channels } = dispatching(MANIFEST);

    await host.actions.invoke(sessionRequest() as never, "news_draft", {});
    await host.actions.list(sessionRequest() as never);

    expect(channels()).toEqual(["plugin", "plugin"]);
  });

  it("is not moved by anything the plugin passes along with the call", async () => {
    // The channel is not an argument. Whatever the plugin puts in the input or
    // the filter, or on the request it hands back, the host reads the manifest.
    const { host, channels } = dispatching({ ...MANIFEST, ai: true });
    const request = Object.assign(sessionRequest(), {
      channel: "web",
      ai: false,
    });

    await host.actions.invoke(request as never, "news_draft", {
      channel: "web",
    });
    await host.actions.list(request as never, { surface: "ui" });

    expect(channels()).toEqual(["ai", "ai"]);
  });
});

/**
 * What a plugin can do to the request it hands back.
 *
 * A plugin's route is given the real request, and everything on it is the
 * plugin's to write: `principal`, `token`, the token's client and its scopes.
 * The channel, the connected app and the scopes a dispatch is decided on are
 * what the guard established when it authenticated the request, so none of
 * these writes reaches the registry or the audit entry. Run through the host's
 * own `host.actions` against a real caller factory and registry, as a plugin
 * would reach them.
 */
describe("what a plugin's dispatch cannot claim", () => {
  const REAL_TOKEN: RequestToken = {
    clientId: "client-1",
    clientHost: "claude.ai",
    scopes: ["mcp:read"],
    tokenRowId: "token-row-1",
  };
  const INVENTED_TOKEN: RequestToken = {
    clientId: "invented-app",
    clientHost: "invented.example",
    scopes: ["mcp:read", "mcp:write"],
    tokenRowId: "not-a-real-token",
  };

  function action(
    name: string,
    surfaces: ActionDefinition["surfaces"],
    effect: ActionDefinition["effect"],
    handler: ActionDefinition["handler"],
  ): ActionDefinition {
    return {
      name,
      titleKey: `actions.${name}.title`,
      descriptionKey: `actions.${name}.description`,
      group: "news",
      groupTitleKey: "actions.group.news.title",
      capability: "site:manage",
      effect,
      idempotent: true,
      additive: false,
      needsConfirmation: false,
      openWorld: false,
      personalData: [],
      surfaces,
      errors: [],
      input: z.strictObject({}),
      output: z.strictObject({}),
      handler,
    } as ActionDefinition;
  }

  /** A host for `manifest`, over a registry holding one action per surface. */
  function dispatching(manifest: PluginManifest) {
    const callers = new ActionCallerFactory();
    const principals = {
      forPerson: vi.fn(async () => ({
        personId: "person-1",
        capabilities: new Set(["site:manage"]),
      })),
    } as unknown as PrincipalService;
    const registry = new ActionRegistryService(
      callers,
      principals,
      { translatorFor: () => (key: string) => key } as unknown as I18nService,
      {
        OPENBRF_ACTIONS_READ_ONLY: false,
        APP_URL: "https://brf.example",
      } as unknown as Env,
      {
        declared: true,
        path: "/api/plugin/connector/mcp",
        url: "https://brf.example/api/plugin/connector/mcp",
      },
    );
    const contexts: ActionContext[] = [];
    const handler = vi.fn(async (_input: unknown, context: ActionContext) => {
      contexts.push(context);
      return {};
    });
    for (const definition of [
      action("news_ui_mcp", ["ui", "mcp"], "write", handler),
      action("news_mcp_read", ["mcp"], "read", handler),
      action("news_ai", ["ai"], "read", handler),
    ]) {
      registry.register(definition, { kind: "core", module: "news" });
    }
    const binding = new PluginHostBinding();
    binding.bind({ ...services().bound, actions: registry, callers });
    const host = createPluginHost(binding, {
      manifest,
      consented: [],
      serving: true,
      bufferedActions: [],
      bufferedBlocks: [],
    });
    const recorded = () =>
      contexts.map((context) => auditActor(actorOf(context)));
    return { host, recorded };
  }

  /** A request as the guard leaves it, with or without a token. */
  function authenticated(token?: RequestToken): Record<string, unknown> {
    const held: Record<string, unknown> = {
      id: "req-1",
      principal: { personId: "person-1" },
      ...(token === undefined
        ? {}
        : { token: { ...token, scopes: [...token.scopes] } }),
    };
    markAuthenticated(held, {
      personId: "person-1",
      token: token ?? null,
      requestId: "req-1",
    });
    return held;
  }

  const listed = async (
    host: ReturnType<typeof dispatching>["host"],
    request: object,
  ) => (await host.actions.list(request as never)).map((one) => one.name);

  it("hands the AI package the schemas of what it lists and of nothing else", async () => {
    // What a connector puts in tools/list: the one action offered on ai, with
    // the document its input is validated against, and no schema for the
    // actions on the other surfaces.
    const { host } = dispatching({ ...MANIFEST, ai: true });

    const offered = await host.actions.list(authenticated() as never, {
      surface: "ui",
    });

    expect(offered).toEqual([
      expect.objectContaining({
        name: "news_ai",
        inputSchema: expect.objectContaining({
          type: "object",
          additionalProperties: false,
        }),
        outputSchema: expect.objectContaining({ type: "object" }),
      }),
    ]);
  });

  it("stays the AI package's when a token is added to a session", async () => {
    // The reported case: before, this request reached an action offered only
    // on ui and mcp, recorded as a connected app that never called.
    const { host, recorded } = dispatching({ ...MANIFEST, ai: true });
    const request = authenticated();
    request.token = INVENTED_TOKEN;

    await expect(
      host.actions.invoke(request as never, "news_ui_mcp", {}),
    ).rejects.toMatchObject({ reason: "forbidden-surface" });
    expect(await listed(host, request)).toEqual(["news_ai"]);

    await host.actions.invoke(request as never, "news_ai", {});
    expect(recorded()).toEqual([
      {
        channel: "AI",
        actorPersonId: "person-1",
        clientId: null,
        clientHost: null,
        pendingChangeId: null,
      },
    ]);
  });

  it("stays a plugin's when a token is added to a session", async () => {
    const { host, recorded } = dispatching(MANIFEST);
    const request = authenticated();
    request.token = INVENTED_TOKEN;

    await expect(
      host.actions.invoke(request as never, "news_mcp_read", {}),
    ).rejects.toMatchObject({ reason: "forbidden-surface" });
    expect(await listed(host, request)).toEqual(["news_ui_mcp"]);

    await host.actions.invoke(request as never, "news_ui_mcp", {});
    expect(recorded()).toEqual([
      {
        channel: "PLUGIN",
        actorPersonId: "person-1",
        clientId: null,
        clientHost: null,
        pendingChangeId: null,
      },
    ]);
  });

  it("stays the connected app's when the token is removed", async () => {
    // Deleting the token would otherwise turn the app's call into the AI
    // package's, on a surface and without scopes the app was never given.
    const { host, recorded } = dispatching({ ...MANIFEST, ai: true });
    const request = authenticated(REAL_TOKEN);
    delete request.token;

    await expect(
      host.actions.invoke(request as never, "news_ai", {}),
    ).rejects.toMatchObject({ reason: "forbidden-surface" });
    expect(await listed(host, request)).toEqual([
      "news_mcp_read",
      "news_ui_mcp",
    ]);

    await host.actions.invoke(request as never, "news_mcp_read", {});
    expect(recorded()).toEqual([
      {
        channel: "MCP",
        actorPersonId: "person-1",
        clientId: "client-1",
        clientHost: "claude.ai",
        pendingChangeId: null,
      },
    ]);
  });

  it("names the app that called when the token is replaced", async () => {
    const { host, recorded } = dispatching({ ...MANIFEST, ai: true });
    const request = authenticated(REAL_TOKEN);
    request.token = INVENTED_TOKEN;

    // The invented token carries mcp:write; the real one does not.
    await expect(
      host.actions.invoke(request as never, "news_ui_mcp", {}),
    ).rejects.toMatchObject({ reason: "insufficient-scope" });

    await host.actions.invoke(request as never, "news_mcp_read", {});
    expect(recorded()).toEqual([
      {
        channel: "MCP",
        actorPersonId: "person-1",
        clientId: "client-1",
        clientHost: "claude.ai",
        pendingChangeId: null,
      },
    ]);
  });

  it("names the app that called when the token's client and scopes are changed", async () => {
    const { host, recorded } = dispatching({ ...MANIFEST, ai: true });
    const request = authenticated(REAL_TOKEN);
    const token = request.token as RequestToken;
    token.scopes.push("mcp:write");
    token.clientId = "invented-app";
    token.clientHost = "invented.example";
    request.principal = { personId: "somebody-else" };

    await expect(
      host.actions.invoke(request as never, "news_ui_mcp", {}),
    ).rejects.toMatchObject({ reason: "insufficient-scope" });

    await host.actions.invoke(request as never, "news_mcp_read", {});
    expect(recorded()).toEqual([
      {
        channel: "MCP",
        actorPersonId: "person-1",
        clientId: "client-1",
        clientHost: "claude.ai",
        pendingChangeId: null,
      },
    ]);
  });
});

/**
 * The association's finances, through the host.
 *
 * The reads and the events behind finances:read, the receipt behind
 * finances:recordDelivery, and both behind the same switch every other service
 * is behind. What a read withholds is the finance service's own business and
 * is proved against a database in `plugin-finances.int-spec.ts`; this proves
 * who may reach it at all.
 */
describe("host.finances", () => {
  let binding: PluginHostBinding;
  let context: PluginHostContext;
  let listen: ReturnType<typeof vi.fn>;
  let record: ReturnType<typeof vi.fn>;
  let notifications: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    binding = new PluginHostBinding();
    context = {
      manifest: { ...MANIFEST, permissions: ["finances:read"] },
      consented: ["finances:read"],
      serving: true,
      bufferedActions: [],
      bufferedBlocks: [],
    };
    listen = vi.fn(async () => undefined);
    record = vi.fn(async () => ({
      id: "receipt-1",
      pluginId: MANIFEST.id,
      channel: "fortnox",
      reference: "VER-1",
      deliveredAt: "2026-10-19T10:00:00.000Z",
      recordedAt: "2026-10-19T10:00:01.000Z",
    }));
    notifications = vi.fn(async () => []);
    binding.bind({
      ...services().bound,
      finances: {
        notifications,
        notification: vi.fn(async () => null),
        charges: vi.fn(async () => []),
        charge: vi.fn(async () => null),
      },
      receipts: { record },
      financeEvents: { listen },
    } as unknown as PluginHostServices);
  });

  it("states which events this host delivers, so a plugin can tell", () => {
    const host = createPluginHost(binding, context);

    expect(host.finances.events.supported).toEqual(PLUGIN_FINANCE_EVENTS);
    expect(Object.isFrozen(host.finances.events.supported)).toBe(true);
  });

  it("refuses every read to a plugin that did not declare finances:read", async () => {
    const host = createPluginHost(binding, {
      ...context,
      consented: ["addressBook:read", "finances:recordDelivery"],
    });

    await expect(host.finances.notifications()).rejects.toBeInstanceOf(
      PluginPermissionError,
    );
    await expect(host.finances.notification("run-1")).rejects.toBeInstanceOf(
      PluginPermissionError,
    );
    await expect(
      host.finances.charges({ from: "2026-01-01", to: "2026-12-31" }),
    ).rejects.toBeInstanceOf(PluginPermissionError);
    await expect(host.finances.charge("charge-1")).rejects.toBeInstanceOf(
      PluginPermissionError,
    );
    await expect(
      host.finances.events.subscribe(() => undefined),
    ).rejects.toBeInstanceOf(PluginPermissionError);
    expect(notifications).not.toHaveBeenCalled();
    expect(listen).not.toHaveBeenCalled();
  });

  it("refuses a receipt to a plugin that only reads", async () => {
    // Reading the books is not writing to them, and the board consented to
    // the one without the other.
    const host = createPluginHost(binding, context);

    await expect(
      host.finances.recordDelivery({
        target: { kind: "feeNotice", id: "notice-1" },
        channel: "fortnox",
        reference: "VER-1",
      }),
    ).rejects.toBeInstanceOf(PluginPermissionError);
    expect(record).not.toHaveBeenCalled();
  });

  it("records a receipt under the host's id for the plugin, never one it chose", async () => {
    const host = createPluginHost(binding, {
      ...context,
      consented: ["finances:recordDelivery"],
    });
    const input = {
      target: { kind: "memberCharge", id: "charge-1" },
      channel: "fortnox",
      reference: "VER-1",
      // Whatever a plugin adds to the input, the receipt names the plugin
      // the host loaded.
      pluginId: "somebody-else",
    } as const;

    const receipt = await host.finances.recordDelivery(input);

    expect(record).toHaveBeenCalledWith(MANIFEST.id, input);
    // What the plugin has just stated comes back to it as it stated it.
    expect(receipt.reference).toEqual({ state: "visible", text: "VER-1" });
  });

  it("listens on the plugin's own queue, and hears nothing once switched off", async () => {
    const host = createPluginHost(binding, context);
    const handler = vi.fn();

    await host.finances.events.subscribe(handler);
    expect(listen).toHaveBeenCalledWith(MANIFEST.id, expect.any(Function));
    const deliver = listen.mock.calls[0]?.[1] as (event: unknown) => unknown;

    const event = {
      type: "memberCharge.recorded",
      version: 1,
      eventId: "event-1",
      occurredAt: "2026-03-05T10:00:00.000Z",
      chargeId: "charge-1",
    };
    await deliver(event);
    expect(handler).toHaveBeenCalledWith(event);

    // An event already queued when the board switched the plugin off is not
    // handed to it: the gate is passed on every delivery, not once at the
    // subscription.
    context.serving = false;
    // The delivery resolves, so the job completes and the event is dropped
    // rather than retried into a plugin that is switched on again later.
    await expect(deliver(event)).resolves.toBeUndefined();
    expect(handler).toHaveBeenCalledTimes(1);
  });
});

/**
 * What `host.actions.invoke` rejects with.
 *
 * The registry refuses in three forms - its own ActionError, the validator's
 * ZodError and the service's own domain error - and a plugin can import none of
 * them. The connector that speaks MCP is a plugin, so each has to reach it as
 * the one refusal the SDK publishes, recognised by the SDK's own guard, with
 * the rendering the catalogue serves over HTTP.
 */
describe("a refused call, as a plugin receives it", () => {
  const CHALLENGE =
    'Bearer error="insufficient_scope", scope="mcp:read mcp:write"';

  class SlugTaken extends DomainError {
    readonly status = 409;
    readonly reason = "slug-taken";

    override details(): Record<string, readonly unknown[]> {
      return { slugs: ["styrelsen"] };
    }
  }

  function host(
    refusal: unknown,
    errors: readonly ActionErrorSpec[] = [],
  ): ReturnType<typeof createPluginHost> {
    const binding = new PluginHostBinding();
    binding.bind({
      ...services().bound,
      callers: { forPlugin: vi.fn(() => ({})) },
      actions: {
        invoke: vi.fn(async () => {
          throw refusal;
        }),
        get: vi.fn(() => ({ definition: { errors } })),
      },
    } as unknown as PluginHostServices);
    return createPluginHost(binding, {
      manifest: MANIFEST,
      consented: ["addressBook:read"],
      serving: true,
      bufferedActions: [],
      bufferedBlocks: [],
    });
  }

  async function rejection(
    plugin: ReturnType<typeof createPluginHost>,
  ): Promise<unknown> {
    return plugin.actions.invoke({}, "page_create", {}).then(
      () => expect.unreachable("the call was refused"),
      (cause: unknown) => cause,
    );
  }

  it.each(ACTION_ERROR_REASONS)(
    "rejects with a refusal the SDK recognises for %s",
    async (reason) => {
      const refused = await rejection(
        host(new ActionError(reason, "Refused.")),
      );

      expect(isActionRefusal(refused)).toBe(true);
      expect(refused).toMatchObject({
        kind: "registry",
        reason,
        status: new ActionError(reason, "").status,
        ...ACTION_ERROR_MCP[reason],
      });
    },
  );

  it("hands the plugin the bearer challenge for a missing scope", async () => {
    // ADR 0009: the connector answers a 403 with this challenge so the client
    // can ask for the scope it lacks. Behind headers() it was out of reach.
    const refused = await rejection(
      host(
        new ActionError(
          "insufficient-scope",
          "This token does not carry mcp:write.",
          { scopes: ["mcp:write"] },
          CHALLENGE,
        ),
      ),
    );

    if (!isActionRefusal(refused)) {
      throw new Error("not a refusal");
    }
    expect(refused.challenge).toBe(CHALLENGE);
    expect(refused.details()).toEqual({ scopes: ["mcp:write"] });
  });

  it("carries no challenge where none would help", async () => {
    const refused = await rejection(
      host(new ActionError("forbidden-capability", "Refused.")),
    );

    expect((refused as { challenge?: string }).challenge).toBeUndefined();
  });

  it("rejects an invalid body as a refusal naming the paths, not the values", async () => {
    const parsed = z
      .strictObject({ title: z.string() })
      .safeParse({ title: 1234567 });
    const refused = await rejection(host(parsed.error));

    if (!isActionRefusal(refused)) {
      throw new Error("not a refusal");
    }
    expect(refused).toMatchObject({
      kind: "invalid-body",
      reason: "invalid-body",
      status: 400,
      ...ACTION_ERROR_MCP["invalid-body"],
    });
    const { issues } = refused.details() as { issues: { path: string }[] };
    expect(issues.map((issue) => issue.path)).toEqual(["title"]);
    expect(JSON.stringify(issues)).not.toContain("1234567");
  });

  it("rejects a domain refusal with the verdict the action declared for it", async () => {
    const refused = await rejection(
      host(new SlugTaken("That address is taken."), [
        {
          reason: "slug-taken",
          retry: "after-edit",
          messageKey: "siteAdmin.errors.slugTaken",
        },
      ]),
    );

    if (!isActionRefusal(refused)) {
      throw new Error("not a refusal");
    }
    expect(refused).toMatchObject({
      kind: "domain",
      reason: "slug-taken",
      status: 409,
      transport: "tool-result",
      retry: "after-edit",
    });
    expect(refused.details()).toEqual({ slugs: ["styrelsen"] });
  });

  it("falls back to the table's verdict for a domain reason the action did not declare", async () => {
    const refused = await rejection(host(new SlugTaken("Taken.")));

    expect(refused).toMatchObject({
      kind: "domain",
      ...ACTION_ERROR_MCP.domain,
    });
  });

  it("recognises a plugin handler's own domain refusal, which cannot extend the host's class", async () => {
    const own = Object.assign(new Error("Closed."), {
      reason: "booking-closed",
      status: 409,
    });
    const refused = await rejection(host(own));

    expect(isActionRefusal(refused)).toBe(true);
    expect(refused).toMatchObject({ kind: "domain", reason: "booking-closed" });
  });

  it("does not call what a handler's own refusal holds as data", async () => {
    // A plugin's error class may keep `details` and `headers` as fields:
    // neither may turn the refusal into a TypeError.
    const own = Object.assign(new Error("Closed."), {
      reason: "booking-closed",
      status: 409,
      details: { slugs: ["styrelsen"] },
      headers: { "www-authenticate": CHALLENGE },
    });
    const refused = await rejection(host(own));

    if (!isActionRefusal(refused)) {
      throw new Error("not a refusal");
    }
    expect(refused.details()).toEqual({});
    expect(refused.challenge).toBeUndefined();
    expect((refused as DomainError).headers?.()).toEqual({});
  });

  it("keeps the headers a handler's own refusal offers as strings", async () => {
    const own = Object.assign(new Error("Closed."), {
      reason: "booking-closed",
      status: 409,
      headers: () => ({ "www-authenticate": CHALLENGE, "retry-after": 30 }),
    });
    const refused = await rejection(host(own));

    if (!isActionRefusal(refused)) {
      throw new Error("not a refusal");
    }
    expect(refused.challenge).toBe(CHALLENGE);
    expect((refused as DomainError).headers?.()).toEqual({
      "www-authenticate": CHALLENGE,
    });
  });

  it("reads the challenge of a handler's own refusal whatever the header's casing", async () => {
    const own = Object.assign(new Error("Closed."), {
      reason: "booking-closed",
      status: 403,
      headers: () => ({ "WWW-Authenticate": CHALLENGE }),
    });
    const refused = await rejection(host(own));

    if (!isActionRefusal(refused)) {
      throw new Error("not a refusal");
    }
    expect(refused.challenge).toBe(CHALLENGE);
  });

  it("drops the headers of a handler's own refusal that the response could not carry", async () => {
    const own = Object.assign(new Error("Closed."), {
      reason: "booking-closed",
      status: 409,
      headers: () => ({
        "www-authenticate": CHALLENGE,
        "bad header": "ok",
        "x-note": "split\r\nvalue",
      }),
    });
    const refused = await rejection(host(own));

    expect((refused as DomainError).headers?.()).toEqual({
      "www-authenticate": CHALLENGE,
    });
  });

  it.each([700, 99, 100, 204, 205, 304, 404.5, Number.NaN])(
    "answers a handler's own refusal with status %s as a 500",
    async (status) => {
      const own = Object.assign(new Error("Closed."), {
        reason: "booking-closed",
        status,
      });
      const refused = await rejection(host(own));

      expect((refused as DomainError).status).toBe(500);
    },
  );

  it.each([
    ["registry", new ActionError("unknown-action", "No such action.")],
    ["invalid-body", z.strictObject({ title: z.string() }).safeParse({}).error],
  ])(
    "keeps a %s refusal as it was when one action rethrows another's",
    async (_kind, inner) => {
      const first = await rejection(host(inner));
      const rethrown = await rejection(host(first));

      expect(rethrown).toBe(first);
    },
  );

  it("passes a failure that is not a refusal through untouched", async () => {
    // A fault is not an answer: a connector must not tell a model it was
    // refused when the database was unreachable.
    const fault = new Error("connection reset");

    await expect(rejection(host(fault))).resolves.toBe(fault);
  });

  it("answers as the registry would when a plugin route rethrows the refusal", async () => {
    // A DomainError passes the plugin error interceptor, and the domain filter
    // writes its status and headers, so rethrowing loses neither the 403 nor
    // the challenge.
    const refused = await rejection(
      host(
        new ActionError(
          "insufficient-scope",
          "Refused.",
          { scopes: ["mcp:write"] },
          CHALLENGE,
        ),
      ),
    );

    expect(refused).toBeInstanceOf(DomainError);
    expect((refused as DomainError).status).toBe(403);
    expect((refused as DomainError).headers?.()).toEqual({
      "www-authenticate": CHALLENGE,
    });
  });
});

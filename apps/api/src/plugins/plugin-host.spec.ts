import { Logger } from "@nestjs/common";
import type {
  ActionContext,
  ActionDefinition,
  PluginManifest,
  PluginPermission,
} from "@openbrf/plugin-sdk";
import {
  PluginHostUnavailableError,
  PluginPermissionError,
} from "@openbrf/plugin-sdk";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import { ActionCallerFactory } from "../actions/action-caller";
import type { ActionCaller } from "../actions/action-caller";
import { ActionRegistryService } from "../actions/action-registry.service";
import { actorOf } from "../actions/actor-of";
import { markAuthenticated } from "../actions/authenticated-request";
import { auditActor } from "../audit/actor-context";
import type { RequestToken } from "../authorization/authorization.guard";
import type { PrincipalService } from "../authorization/principal.service";
import type { Env } from "../config/env";
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
    expect(routeCapabilityFloor([])).toBe("self:manage");
  });

  it.each<PluginPermission>(["addressBook:read", "addressBook:readContact"])(
    "raises the floor to addressBook:read for a plugin holding %s",
    (permission) => {
      // Both permissions reach register data that is board-only in the core
      // product, so both put the plugin's routes behind the same capability the
      // core requires to read it.
      expect(routeCapabilityFloor([permission])).toBe("addressBook:read");
    },
  );

  it("raises the floor for a plugin holding both address book permissions", () => {
    expect(
      routeCapabilityFloor(["addressBook:read", "addressBook:readContact"]),
    ).toBe("addressBook:read");
  });

  it("does not raise the floor for a permission that reads no register data", () => {
    // Sending mail, sending SMS and running jobs reach nothing the caller of a
    // route could read back, so gating those routes above self:manage would
    // lock residents out of plugins written for them.
    expect(routeCapabilityFloor(["mail:send"])).toBe("self:manage");
    expect(routeCapabilityFloor(["sms:send"])).toBe("self:manage");
    expect(routeCapabilityFloor(["jobs:schedule"])).toBe("self:manage");
    expect(
      routeCapabilityFloor(["mail:send", "sms:send", "jobs:schedule"]),
    ).toBe("self:manage");
  });

  it("raises the floor when a register permission sits among others", () => {
    expect(
      routeCapabilityFloor([
        "mail:send",
        "jobs:schedule",
        "addressBook:readContact",
      ]),
    ).toBe("addressBook:read");
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
      list: vi.fn(async (caller: ActionCaller) => {
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
      action("news_ai", ["ai"], "write", handler),
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
      },
    ]);
  });
});

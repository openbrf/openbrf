import { Logger } from "@nestjs/common";
import type {
  ActionContext,
  ActionDefinition,
  ActionErrorSpec,
  PluginAuditEntry,
  PluginHost,
  PluginManifest,
  PluginPermission,
} from "@openbrf/plugin-sdk";
import {
  ACTION_ERROR_MCP,
  ACTION_ERROR_REASONS,
  isActionRefusal,
  PLUGIN_AUDIT_LIMITS,
  PLUGIN_FINANCE_EVENTS,
  PluginAuditRateError,
  PluginHostUnavailableError,
  PluginPermissionError,
  PluginRequestContextError,
  type PluginRequestMember,
  PluginResidentRouteError,
  type PluginResidentRouteRefusedMember,
} from "@openbrf/plugin-sdk";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";
import { z } from "zod";

import { ActionCallerFactory } from "../actions/action-caller";
import type { ActionCaller, RequestWithToken } from "../actions/action-caller";
import { ActionRegistryService } from "../actions/action-registry.service";
import { ActionError } from "../actions/action.error";
import { markDeviceRequest } from "../devices/device-request";
import { actorOf } from "../actions/actor-of";
import { markAuthenticated } from "../actions/authenticated-request";
import { LiveResponse } from "../actions/testing/live-response";
import { auditActor } from "../audit/actor-context";
import type { AuditLogService } from "../audit/audit-log.service";
import type { RequestToken } from "../authorization/authorization.guard";
import type { PrincipalService } from "../authorization/principal.service";
import type { Env } from "../config/env";
import { DomainError } from "../http/domain-error";
import type { I18nService } from "../i18n/i18n.service";
import {
  checkedPluginAuditEntry,
  PluginAuditService,
} from "./plugin-audit.service";
import type { PluginLoaderService } from "./plugin-loader.service";
import {
  createPluginHost,
  extensionGroupFloors,
  PluginHostBinding,
  type PluginHostContext,
  type PluginHostServices,
  routeCapabilityFloor,
  routeFloorsRaisedBy,
} from "./plugin-host";
import {
  RESIDENT_ROUTE_ANSWER_WAIT_MS,
  residentRouteHandler,
  runOnResidentRoute,
} from "./resident-route-scope";
import { runServingRequest } from "./served-request";
import { servingEach, servingUntilAnswered } from "./testing/serving";

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
    // lock residents out of plugins written for them.
    expect(routeCapabilityFloor(["mail:send"])).toEqual(["self:manage"]);
    expect(routeCapabilityFloor(["sms:send"])).toEqual(["self:manage"]);
    expect(routeCapabilityFloor(["jobs:schedule"])).toEqual(["self:manage"]);
    expect(
      routeCapabilityFloor(["mail:send", "sms:send", "jobs:schedule"]),
    ).toEqual(["self:manage"]);
  });

  it.each<PluginPermission>([
    "news:read",
    "calendar:read",
    "bookings:readAvailability",
    "media:read",
    "addresses:read",
  ])("does not raise the floor for %s", (permission) => {
    // What these read is what anybody signed in may read already, and
    // free/busy is less than a resident's own booking screen shows (ADR 0032).
    expect(routeCapabilityFloor([permission])).toEqual(["self:manage"]);
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

  it("puts a plugin recording deliveries behind the same two, though it reads nothing", () => {
    // A receipt is written against a notice or a charge, and a route that
    // records one on its caller's say would otherwise let any account put a
    // delivery beside the board's books.
    expect(routeCapabilityFloor(["finances:recordDelivery"])).toEqual([
      "fees:manage",
      "memberCharges:manage",
    ]);
    expect(
      routeCapabilityFloor(["mail:send", "finances:recordDelivery"]),
    ).toEqual(["fees:manage", "memberCharges:manage"]);
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
 * The floor of plugins joined by extensions (ADR 0052).
 *
 * An addon hands its host plugin data in a point's output and the host plugin
 * hands its addons data in a point's input, and the host copies both without
 * reading them. A plugin that reads nothing can therefore hold a name another
 * plugin of its group read, so each member is held to the group's floor.
 */
describe("extensionGroupFloors", () => {
  const member = (
    id: string,
    permissions: PluginPermission[] = [],
    extended: string[] = [],
  ) => ({
    id,
    permissions,
    extends: extended.map((plugin) => ({ plugin })),
  });

  it("holds a host plugin that reads nothing to the floor of its addon that reads contacts", () => {
    const floors = extensionGroupFloors([
      member("signage", ["mail:send"]),
      member("signage-residents", ["addressBook:readContact"], ["signage"]),
    ]);

    expect(floors.get("signage")).toEqual(["addressBook:read"]);
    expect(floors.get("signage-residents")).toEqual(["addressBook:read"]);
  });

  it("holds another addon of that host plugin to the same floor", () => {
    // The host plugin can hand the name on as the weather addon's input.
    const floors = extensionGroupFloors([
      member("signage"),
      member("signage-weather", [], ["signage"]),
      member("signage-residents", ["addressBook:read"], ["signage"]),
    ]);

    expect(floors.get("signage-weather")).toEqual(["addressBook:read"]);
  });

  it("joins two host plugins through an addon that extends both", () => {
    const floors = extensionGroupFloors([
      member("signage"),
      member("bookings"),
      member("bridge", [], ["signage", "bookings"]),
      member("dues", ["finances:read"], ["bookings"]),
    ]);

    expect(floors.get("signage")).toEqual([
      "fees:manage",
      "memberCharges:manage",
    ]);
  });

  it("leaves a plugin outside the group on its own floor", () => {
    const floors = extensionGroupFloors([
      member("signage"),
      member("signage-residents", ["addressBook:read"], ["signage"]),
      member("parking"),
    ]);

    expect(floors.get("parking")).toEqual(["self:manage"]);
  });

  it("is joined by no extension naming a plugin that is not among them", () => {
    // A host plugin switched off, or not installed, carries nothing between
    // two of its addons.
    const floors = extensionGroupFloors([
      member("signage-residents", ["addressBook:read"], ["signage"]),
      member("signage-weather", [], ["signage"]),
    ]);

    expect(floors.get("signage-weather")).toEqual(["self:manage"]);
  });

  it("keeps a group with no register permission at self:manage", () => {
    const floors = extensionGroupFloors([
      member("signage", ["mail:send"]),
      member("signage-weather", ["jobs:schedule"], ["signage"]),
    ]);

    expect(floors.get("signage")).toEqual(["self:manage"]);
    expect(floors.get("signage-weather")).toEqual(["self:manage"]);
  });
});

/**
 * What the consent screen names before an install raises a floor (ADR 0052):
 * the installed plugins whose group floor the candidate raises.
 */
describe("routeFloorsRaisedBy", () => {
  const member = (
    id: string,
    permissions: PluginPermission[] = [],
    extended: string[] = [],
  ) => ({
    id,
    permissions,
    extends: extended.map((plugin) => ({ plugin })),
  });

  it("names the host plugin and its other addons for an addon that reads contacts", () => {
    expect(
      routeFloorsRaisedBy(
        [
          member("signage"),
          member("signage-weather", [], ["signage"]),
          member("parking"),
        ],
        member("signage-residents", ["addressBook:readContact"], ["signage"]),
      ),
    ).toEqual(["signage", "signage-weather"]);
  });

  it("names a plugin already held to the address book that the finances raise further", () => {
    expect(
      routeFloorsRaisedBy(
        [member("bookings", ["addressBook:read"])],
        member("dues", ["finances:read"], ["bookings"]),
      ),
    ).toEqual(["bookings"]);
  });

  it("names nothing for an addon that reads nothing", () => {
    expect(
      routeFloorsRaisedBy(
        [member("signage", ["mail:send"])],
        member("signage-weather", ["jobs:schedule"], ["signage"]),
      ),
    ).toEqual([]);
  });

  it("names nothing where the group is held to that floor already", () => {
    expect(
      routeFloorsRaisedBy(
        [
          member("signage"),
          member("signage-residents", ["addressBook:read"], ["signage"]),
        ],
        member("signage-names", ["addressBook:readContact"], ["signage"]),
      ),
    ).toEqual([]);
  });

  it("names nothing for an addon whose host plugin is not installed", () => {
    expect(
      routeFloorsRaisedBy(
        [member("parking")],
        member("signage-residents", ["addressBook:read"], ["signage"]),
      ),
    ).toEqual([]);
  });

  it("reads an update in place of the release installed", () => {
    // The update keeps reading what the installed release read, so nothing
    // rises; one that stops reading lowers the group, which names nothing.
    const installed = [
      member("signage"),
      member("signage-residents", ["addressBook:read"], ["signage"]),
    ];

    expect(
      routeFloorsRaisedBy(
        installed,
        member("signage-residents", ["addressBook:read"], ["signage"]),
      ),
    ).toEqual([]);
    expect(
      routeFloorsRaisedBy(
        installed,
        member("signage-residents", [], ["signage"]),
      ),
    ).toEqual([]);
  });

  it("names the plugins an addon joins to a group that reads, though it reads nothing", () => {
    // The bridge carries what the dues addon reads on to parking.
    expect(
      routeFloorsRaisedBy(
        [
          member("bookings"),
          member("dues", ["finances:read"], ["bookings"]),
          member("parking"),
        ],
        member("bridge", [], ["bookings", "parking"]),
      ),
    ).toEqual(["parking"]);
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
  personRecords: [],
  id: "occupancy",
  entry: { server: "./dist/server.cjs" },
  permissions: ["addressBook:read"],
  personalData: ["name"],
  actions: [],
  deviceRoutes: [],
  residentRoutes: [],
  ai: false,
  blocks: [],
  extensionPoints: [],
  extends: [],
  recipients: [],
};

/**
 * A double for each application service, with the address book and the SMS
 * service spied on.
 */
function services(): {
  bound: PluginHostServices;
  residents: ReturnType<typeof vi.fn>;
  summary: ReturnType<typeof vi.fn>;
  sms: ReturnType<typeof vi.fn>;
  content: Record<
    | "published"
    | "occurrences"
    | "meetingNotices"
    | "resources"
    | "busy"
    | "open"
    | "list",
    ReturnType<typeof vi.fn>
  >;
} {
  const residents = vi.fn(async () => []);
  const summary = vi.fn(async () => ({
    apartments: 1,
    residents: 2,
    members: 3,
  }));
  const sms = vi.fn(async () => undefined);
  const content = {
    published: vi.fn(async () => []),
    occurrences: vi.fn(async () => []),
    meetingNotices: vi.fn(async () => []),
    resources: vi.fn(async () => []),
    busy: vi.fn(async () => []),
    open: vi.fn(async () => null),
    list: vi.fn(async () => []),
  };
  return {
    residents,
    summary,
    sms,
    content,
    bound: {
      registry: { find: vi.fn(async () => null) },
      jobs: { send: vi.fn(async () => undefined) },
      mail: { send: vi.fn(async () => undefined) },
      sms: { send: sms },
      addressBook: {
        summary,
        residents,
        apartments: vi.fn(async () => []),
      },
      news: { published: content.published },
      calendar: {
        occurrences: content.occurrences,
        meetingNotices: content.meetingNotices,
      },
      bookings: { resources: content.resources, busy: content.busy },
      media: { open: content.open },
      addresses: { list: content.list },
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
      bufferedExtensionPoints: [],
      bufferedContributions: [],
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
    expect(residents).toHaveBeenCalledWith("occupancy", {
      contact: true,
      filter: undefined,
    });
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
    expect(() => host.actions.client({})).toThrow(PluginHostUnavailableError);
  });

  /**
   * Extension points (ADR 0030). `define` and `contribute` are declarations
   * and are buffered; `list` and `invoke` keep the gate, and refuse a point
   * the plugin's own manifest does not declare.
   */
  describe("extensions", () => {
    const declaring: PluginManifest = {
      ...MANIFEST,
      extensionPoints: [{ id: "source", version: 1, personalData: [] }],
    };

    it("buffers a definition and a contribution made before the application exists", () => {
      const host = createPluginHost(binding, context);
      const definition = { input: {}, output: {} } as never;
      const contribution = { titleKey: "t", handler: async () => ({}) };

      host.extensions.define("source", definition);
      host.extensions.contribute(
        { plugin: "signage", point: "source" },
        contribution,
      );

      expect(context.bufferedExtensionPoints).toEqual([
        { point: "source", definition },
      ]);
      expect(context.bufferedContributions).toEqual([
        { target: { plugin: "signage", point: "source" }, contribution },
      ]);
    });

    it("calls through to the service for a point the manifest declares", async () => {
      const list = vi.fn(() => []);
      const invoke = vi.fn(async () => ({ ok: true, value: {} }));
      binding.bind({
        ...services().bound,
        extensions: { list, invoke },
      } as unknown as PluginHostServices);
      const host = createPluginHost(binding, {
        ...context,
        manifest: declaring,
      });

      await host.extensions.list("source");
      await host.extensions.invoke("source", "signage-weather", {});

      expect(list).toHaveBeenCalledWith("occupancy", "source");
      expect(invoke).toHaveBeenCalledWith(
        "occupancy",
        "source",
        "signage-weather",
        {},
        undefined,
      );
    });

    it("refuses a point the manifest does not declare", async () => {
      binding.bind(services().bound);
      const host = createPluginHost(binding, context);

      await expect(host.extensions.list("source")).rejects.toThrow(
        /does not declare/,
      );
      await expect(
        host.extensions.invoke("source", "signage-weather", {}),
      ).rejects.toThrow(/does not declare/);
    });

    it("refuses once the plugin stops serving", async () => {
      binding.bind(services().bound);
      const host = createPluginHost(binding, {
        ...context,
        manifest: declaring,
        serving: false,
      });

      await expect(host.extensions.list("source")).rejects.toBeInstanceOf(
        PluginHostUnavailableError,
      );
    });
  });

  /**
   * The way out needs no permission, because the declaration is the consent,
   * and it is held to the plugin's own manifest: the plugin names a recipient
   * by id and never hands the host a list of its own.
   */
  it("reaches a recipient through the manifest's declaration and no other", async () => {
    const { bound } = services();
    const fetch = vi.fn(async () => ({ status: 200 }));
    binding.bind({ ...bound, recipients: { fetch } } as never);
    const recipient = {
      id: "model-provider",
      origin: "https://api.example.com",
      purpose: { sv: "Modellen", en: "The model" },
      personalData: [],
    };
    const host = createPluginHost(binding, {
      ...context,
      manifest: { ...MANIFEST, recipients: [recipient] },
    });

    await host.recipients.fetch("model-provider", "/v1/models");

    expect(fetch).toHaveBeenCalledWith(
      MANIFEST.id,
      [recipient],
      "model-provider",
      "/v1/models",
      undefined,
    );

    context.serving = false;
    const switchedOff = createPluginHost(binding, context);
    await expect(
      switchedOff.recipients.fetch("model-provider", "/v1/models"),
    ).rejects.toBeInstanceOf(PluginHostUnavailableError);
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
    expect(residents).toHaveBeenNthCalledWith(1, "occupancy", {
      contact: false,
      filter: undefined,
    });
    expect(residents).toHaveBeenNthCalledWith(2, "occupancy", {
      contact: true,
      filter: undefined,
    });
  });

  /**
   * Which plugin is reading decides who is left out (ADR 0035), so the id is
   * the host object's and never something the plugin passes.
   */
  it("reads the residents as the plugin the host object was built for, narrowed to one entrance when asked", async () => {
    const { bound, residents, summary } = services();
    binding.bind(bound);
    const host = createPluginHost(binding, context);

    await host.addressBook.residents({ addressId: "address-1" });
    await host.addressBook.summary();

    expect(residents).toHaveBeenCalledWith("occupancy", {
      contact: false,
      filter: { addressId: "address-1" },
    });
    expect(summary).toHaveBeenCalledWith("occupancy");
  });

  it("refuses a filter whose addressId is not a string", async () => {
    const { bound, residents } = services();
    binding.bind(bound);
    const host = createPluginHost(binding, context);

    await expect(
      host.addressBook.residents({ addressId: 42 } as never),
    ).rejects.toBeInstanceOf(TypeError);
    await expect(
      host.addressBook.residents("address-1" as never),
    ).rejects.toBeInstanceOf(TypeError);
    expect(residents).not.toHaveBeenCalled();
  });

  describe("host.audit", () => {
    function audited(consented: PluginPermission[] = []): {
      host: ReturnType<typeof createPluginHost>;
      record: ReturnType<typeof vi.fn>;
      forPlugin: ReturnType<typeof vi.fn>;
    } {
      const { bound } = services();
      const record = vi.fn(async () => undefined);
      const handle = {};
      const forPlugin = vi.fn(() => handle);
      binding.bind({
        ...bound,
        audit: { record },
        callers: {
          forPlugin,
          resolve: (caller: unknown) => {
            expect(caller).toBe(handle);
            return {
              personId: "person-board",
              channel: "plugin",
              client: null,
              scopes: [],
              requestId: "request-1",
            };
          },
        },
      } as unknown as PluginHostServices);
      // No permission: what a plugin did is the association's to have a
      // record of, whatever it was allowed to read.
      context.consented = consented;
      return { host: createPluginHost(binding, context), record, forPlugin };
    }

    it("names as the actor the person the host marked on the request", async () => {
      const { host, record, forPlugin } = audited();
      const request = { id: "request-1" };

      await runServingRequest(request, () =>
        host.audit.record(request, {
          event: "screen.residents-enabled",
          targetKind: "screen",
          targetId: "screen-1",
        }),
      );

      expect(forPlugin).toHaveBeenCalledWith(request, {
        id: "occupancy",
        ai: false,
      });
      expect(record).toHaveBeenCalledWith(
        "occupancy",
        { personId: "person-board", clientId: null, clientHost: null },
        {
          event: "screen.residents-enabled",
          targetKind: "screen",
          targetId: "screen-1",
        },
      );
    });

    it("writes no actor without a request", async () => {
      const { host, record, forPlugin } = audited();

      await host.audit.record(null, { event: "cache.cleared" });

      expect(forPlugin).not.toHaveBeenCalled();
      expect(record).toHaveBeenCalledWith("occupancy", null, {
        event: "cache.cleared",
      });
    });

    it("refuses once the plugin stops serving", async () => {
      const { host, record } = audited();
      context.serving = false;

      await expect(
        host.audit.record(null, { event: "cache.cleared" }),
      ).rejects.toBeInstanceOf(PluginHostUnavailableError);
      expect(record).not.toHaveBeenCalled();
    });

    /*
     * ADR 0047: the entry may name the person it is about, held to the rule a
     * record about a person is, which the host asks under its own plugin id.
     */
    it("names a subject the plugin may name, and refuses one it may not", async () => {
      const { host, record } = audited(["addressBook:read"]);
      const mayName = vi.fn(
        async (_pluginId: string, subject: string) => subject === "person-1",
      );
      binding.bind({
        ...binding.resolve("occupancy"),
        personRecords: { mayName },
      } as unknown as PluginHostServices);

      await host.audit.record(null, {
        event: "claim.withdrawn",
        subject: "person-1",
      });
      await expect(
        host.audit.record(null, {
          event: "claim.withdrawn",
          subject: "person-2",
        }),
      ).rejects.toMatchObject({ name: "PluginRecordSubjectError" });

      expect(mayName).toHaveBeenCalledWith("occupancy", "person-1");
      expect(record).toHaveBeenCalledTimes(1);
      expect(record).toHaveBeenCalledWith("occupancy", null, {
        event: "claim.withdrawn",
        subject: "person-1",
      });
    });

    /*
     * Whether a subject is accepted says whether the address book lists the
     * person to the plugin, so naming one is a read of the address book.
     */
    it("refuses a subject from a plugin that does not read the address book", async () => {
      const { host, record } = audited();
      const mayName = vi.fn(async () => true);
      binding.bind({
        ...binding.resolve("occupancy"),
        personRecords: { mayName },
      } as unknown as PluginHostServices);

      await expect(
        host.audit.record(null, {
          event: "claim.withdrawn",
          subject: "person-1",
        }),
      ).rejects.toBeInstanceOf(PluginPermissionError);
      await host.audit.record(null, { event: "claim.withdrawn" });

      expect(mayName).not.toHaveBeenCalled();
      expect(record).toHaveBeenCalledTimes(1);
      expect(record).toHaveBeenCalledWith("occupancy", null, {
        event: "claim.withdrawn",
      });
    });

    it("names a subject for a plugin that reads contact details too", async () => {
      const { host, record } = audited(["addressBook:readContact"]);
      binding.bind({
        ...binding.resolve("occupancy"),
        personRecords: { mayName: vi.fn(async () => true) },
      } as unknown as PluginHostServices);

      await host.audit.record(null, {
        event: "claim.withdrawn",
        subject: "person-1",
      });

      expect(record).toHaveBeenCalledTimes(1);
    });

    /*
     * The entry is read once, and what the host checked is what the audit
     * service is handed: a getter that answers nothing to the host's read and
     * a person to a later one must not name that person unchecked.
     */
    describe("a subject read through a getter", () => {
      function checking(): {
        host: ReturnType<typeof createPluginHost>;
        mayName: ReturnType<typeof vi.fn>;
        written: PluginAuditEntry[];
      } {
        const { host } = audited(["addressBook:read"]);
        const written: PluginAuditEntry[] = [];
        const mayName = vi.fn(
          async (_pluginId: string, subject: string) => subject === "person-1",
        );
        binding.bind({
          ...binding.resolve("occupancy"),
          personRecords: { mayName },
          // The service's own check, so the entry is read as it would be.
          audit: {
            record: vi.fn(
              async (pluginId: string, _actor: unknown, input: unknown) => {
                written.push(checkedPluginAuditEntry(pluginId, input));
              },
            ),
          },
        } as unknown as PluginHostServices);
        return { host, mayName, written };
      }

      it("writes no subject when the host's read found none", async () => {
        const { host, mayName, written } = checking();
        let reads = 0;

        await host.audit.record(null, {
          event: "changed",
          get subject() {
            reads += 1;
            return reads === 1 ? undefined : "person-forbidden";
          },
        });

        expect(reads).toBe(1);
        expect(mayName).not.toHaveBeenCalled();
        expect(written).toEqual([{ event: "changed" }]);
      });

      it("writes the subject the host checked, not a later answer", async () => {
        const { host, mayName, written } = checking();
        let reads = 0;

        await host.audit.record(null, {
          event: "changed",
          get subject() {
            reads += 1;
            return reads === 1 ? "person-1" : "person-forbidden";
          },
        });

        expect(reads).toBe(1);
        expect(mayName).toHaveBeenCalledTimes(1);
        expect(mayName).toHaveBeenCalledWith("occupancy", "person-1");
        expect(written).toEqual([{ event: "changed", subject: "person-1" }]);
      });

      it("still refuses an entry that is not an object", async () => {
        const { host, mayName, written } = checking();
        const entry = Object.assign([], {
          event: "changed",
          get subject() {
            return "person-forbidden";
          },
        });

        await expect(
          host.audit.record(null, entry as never),
        ).rejects.toBeInstanceOf(RangeError);
        await expect(
          host.audit.record(null, null as never),
        ).rejects.toBeInstanceOf(RangeError);
        expect(mayName).not.toHaveBeenCalled();
        expect(written).toEqual([]);
      });
    });
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

    const receipt = await runServingRequest(request, () =>
      createPluginHost(binding, context).actions.propose(
        request,
        "page_update",
        { id: "page-1" },
      ),
    );

    // The person comes from the request the host authenticated, never from
    // an argument, exactly as for invoke.
    expect(forPlugin).toHaveBeenCalledWith(request, {
      id: "occupancy",
      ai: false,
    });
    expect(propose).toHaveBeenCalledWith(caller, "page_update", {
      id: "page-1",
    });
    expect(receipt).toEqual({
      id: "pending-1",
      expiresAt: new Date("2026-10-27T12:00:00Z"),
      path: "/app/pending-changes/pending-1",
    });
  });

  /**
   * The content services (ADR 0032) pass the same gate as every other
   * service: each answers only to its own permission, so consenting to the
   * news is not consenting to free/busy, and none of them answers once the
   * plugin is switched off.
   */
  describe("the association's content", () => {
    const RANGE = {
      from: "2026-11-01T00:00:00Z",
      to: "2026-11-08T00:00:00Z",
    };

    function reads(host: PluginHost): (() => Promise<unknown>)[] {
      return [
        () => host.news.published(),
        () => host.calendar.occurrences(RANGE),
        () => host.calendar.meetingNotices(),
        () => host.bookings.resources(),
        () => host.bookings.busy(RANGE),
        () => host.media.open("logo"),
        () => host.addresses.list(),
      ];
    }

    it("refuses every content read to a plugin that declared none of them", async () => {
      const { bound, content } = services();
      binding.bind(bound);
      const host = createPluginHost(binding, context);

      for (const read of reads(host)) {
        await expect(read()).rejects.toBeInstanceOf(PluginPermissionError);
      }
      for (const read of Object.values(content)) {
        expect(read).not.toHaveBeenCalled();
      }
    });

    it("answers each read only to its own permission", async () => {
      const { bound } = services();
      binding.bind(bound);
      const only = (permission: PluginPermission) =>
        createPluginHost(binding, { ...context, consented: [permission] });

      const news = only("news:read");
      await expect(news.news.published()).resolves.toEqual([]);
      await expect(news.calendar.meetingNotices()).rejects.toMatchObject({
        permission: "calendar:read",
      });
      await expect(news.bookings.resources()).rejects.toMatchObject({
        permission: "bookings:readAvailability",
      });

      const calendar = only("calendar:read");
      await expect(calendar.calendar.occurrences(RANGE)).resolves.toEqual([]);
      await expect(calendar.calendar.meetingNotices()).resolves.toEqual([]);
      await expect(calendar.news.published()).rejects.toMatchObject({
        permission: "news:read",
      });

      const bookings = only("bookings:readAvailability");
      await expect(bookings.bookings.resources()).resolves.toEqual([]);
      await expect(bookings.bookings.busy(RANGE)).resolves.toEqual([]);
      await expect(bookings.calendar.occurrences(RANGE)).rejects.toMatchObject({
        permission: "calendar:read",
      });

      const media = only("media:read");
      await expect(media.media.open("logo")).resolves.toBeNull();
      await expect(media.addresses.list()).rejects.toMatchObject({
        permission: "addresses:read",
      });

      // The house's addresses are not the address book, nor the other way
      // round: each is its own consent.
      const addresses = only("addresses:read");
      await expect(addresses.addresses.list()).resolves.toEqual([]);
      await expect(addresses.addressBook.apartments()).rejects.toMatchObject({
        permission: "addressBook:read",
      });
      await expect(
        only("addressBook:read").addresses.list(),
      ).rejects.toMatchObject({ permission: "addresses:read" });
      await expect(addresses.media.open("logo")).rejects.toMatchObject({
        permission: "media:read",
      });
    });

    it("hands the service what the plugin passed", async () => {
      const { bound, content } = services();
      binding.bind(bound);
      const host = createPluginHost(binding, {
        ...context,
        consented: [
          "news:read",
          "calendar:read",
          "bookings:readAvailability",
          "media:read",
        ],
      });

      await host.news.published({ audience: "anyone", limit: 5 });
      await host.news.published();
      await host.calendar.occurrences({ ...RANGE, audience: "members" });
      await host.bookings.busy({ ...RANGE, resourceIds: ["laundry"] });
      await host.media.open("logo");

      const open = { forDevices: false };
      expect(content.published).toHaveBeenNthCalledWith(
        1,
        { audience: "anyone", limit: 5 },
        open,
      );
      expect(content.published).toHaveBeenNthCalledWith(2, {}, open);
      expect(content.occurrences).toHaveBeenCalledWith(
        { ...RANGE, audience: "members" },
        open,
      );
      expect(content.busy).toHaveBeenCalledWith(
        { ...RANGE, resourceIds: ["laundry"] },
        open,
      );
      expect(content.open).toHaveBeenCalledWith("logo");
    });

    /**
     * The register check of ADR 0032 runs for a plugin that declares a device
     * route, and the host says so from the manifest: nothing the plugin passes
     * can turn it off.
     */
    it("tells each read whether the plugin declares a device route", async () => {
      const { bound, content } = services();
      binding.bind(bound);
      const host = createPluginHost(binding, {
        ...context,
        manifest: {
          ...MANIFEST,
          deviceRoutes: [{ id: "screen", path: "screen" }],
        },
        consented: ["news:read", "calendar:read", "bookings:readAvailability"],
      });

      await host.news.published({ forDevices: false } as never);
      await host.calendar.occurrences(RANGE);
      await host.calendar.meetingNotices();
      await host.bookings.resources();
      await host.bookings.busy(RANGE);

      const device = { forDevices: true };
      expect(content.published).toHaveBeenCalledWith(
        { forDevices: false },
        device,
      );
      expect(content.occurrences).toHaveBeenCalledWith(RANGE, device);
      expect(content.meetingNotices).toHaveBeenCalledWith(device);
      expect(content.resources).toHaveBeenCalledWith(device);
      expect(content.busy).toHaveBeenCalledWith(RANGE, device);
    });

    it("refuses every content read once the plugin stops serving", async () => {
      binding.bind(services().bound);
      context.consented = [
        "news:read",
        "calendar:read",
        "bookings:readAvailability",
        "media:read",
        "addresses:read",
      ];
      const host = createPluginHost(binding, context);
      context.serving = false;

      for (const read of reads(host)) {
        await expect(read()).rejects.toBeInstanceOf(PluginHostUnavailableError);
      }
    });
  });

  /**
   * The association's name and the public origin, which a plugin hands to a
   * screen it pairs (ADR 0034). Public already, so no permission; gated all
   * the same, because a plugin switched off introduces nobody.
   */
  describe("host.instance", () => {
    const FACTS = { name: "Brf Talgoxen", origin: "https://brf.example.se" };

    function bound(): {
      bound: PluginHostServices;
      read: ReturnType<typeof vi.fn>;
    } {
      const read = vi.fn(async () => FACTS);
      const { bound } = services();
      return {
        bound: {
          ...bound,
          instance: { read },
        } as unknown as PluginHostServices,
        read,
      };
    }

    it("answers a plugin that declared no permission", async () => {
      const { bound: doubles, read } = bound();
      binding.bind(doubles);
      const host = createPluginHost(binding, {
        ...context,
        manifest: { ...MANIFEST, permissions: [], personalData: [] },
        consented: [],
      });

      await expect(host.instance?.read()).resolves.toEqual(FACTS);
      expect(read).toHaveBeenCalledOnce();
    });

    it("refuses before the application has started", async () => {
      const host = createPluginHost(binding, context);

      await expect(host.instance?.read()).rejects.toBeInstanceOf(
        PluginHostUnavailableError,
      );
    });

    it("refuses once the plugin stops serving", async () => {
      const { bound: doubles, read } = bound();
      binding.bind(doubles);
      const host = createPluginHost(binding, context);
      context.serving = false;

      await expect(host.instance?.read()).rejects.toBeInstanceOf(
        PluginHostUnavailableError,
      );
      expect(read).not.toHaveBeenCalled();
    });
  });

  /**
   * A plugin's own records need no permission, and the id they are kept under
   * is the host object's: a plugin cannot name another plugin's records,
   * because nothing it passes is the plugin id.
   */
  it("keeps records under the host object's own id, with no permission", async () => {
    const { bound } = services();
    const put = vi.fn(async () => ({}));
    const get = vi.fn(async () => null);
    const list = vi.fn(async () => []);
    const remove = vi.fn(async () => true);
    binding.bind({
      ...bound,
      records: { put, get, list, delete: remove },
    } as unknown as PluginHostServices);
    const host = createPluginHost(binding, { ...context, consented: [] });

    await host.records.put("screens", "hall", { rotation: 10 });
    await host.records.put(
      "screens",
      "hall",
      { rotation: 12 },
      { expectedRevision: 1 },
    );
    await host.records.get("screens", "hall");
    await host.records.list("screens", { after: "hall", limit: 5 });
    await host.records.delete("screens", "hall", { expectedRevision: 2 });

    expect(put).toHaveBeenNthCalledWith(
      1,
      "occupancy",
      "screens",
      "hall",
      { rotation: 10 },
      undefined,
    );
    expect(put).toHaveBeenNthCalledWith(
      2,
      "occupancy",
      "screens",
      "hall",
      { rotation: 12 },
      1,
    );
    expect(get).toHaveBeenCalledWith("occupancy", "screens", "hall");
    expect(list).toHaveBeenCalledWith("occupancy", "screens", {
      after: "hall",
      limit: 5,
    });
    expect(remove).toHaveBeenCalledWith("occupancy", "screens", "hall", 2);
  });

  /**
   * ADR 0047: a collection declared under `personRecords` is that store's, and
   * neither member reaches the other's. What `personRecords` is handed is the
   * manifest's declaration, never one the plugin passes.
   */
  it("keeps the two stores to their own collections", async () => {
    const { bound } = services();
    const put = vi.fn(async () => ({}));
    const personPut = vi.fn(async () => ({}));
    const personGet = vi.fn(async () => null);
    const personDelete = vi.fn(async () => true);
    binding.bind({
      ...bound,
      records: { put },
      personRecords: {
        put: personPut,
        get: personGet,
        delete: personDelete,
      },
    } as unknown as PluginHostServices);
    const claims = {
      collection: "claims",
      titleKey: "records.claims.title",
      personalData: ["apartment" as const],
      keepAtMostDays: 730,
      fields: [],
    };
    const host = createPluginHost(binding, {
      ...context,
      manifest: { ...context.manifest, personRecords: [claims] },
      consented: [],
    });

    await expect(
      host.records.put("claims", "space-12", { taken: true }),
    ).rejects.toBeInstanceOf(RangeError);
    expect(put).not.toHaveBeenCalled();

    const record = {
      subject: "person-1",
      eraseOn: "2027-01-01",
      value: { space: "12" },
    };
    const identity = "6f1c2a4e-0b7d-4c5e-9a8f-3d2e1b0c9a87";
    await host.personRecords.put("claims", "space-12", record, {
      expectedRevision: 2,
      expectedIdentity: identity,
    });
    await host.personRecords.get("claims", "space-12");
    await host.personRecords.delete("claims", "space-12", {
      expectedRevision: 3,
      expectedIdentity: identity,
    });
    expect(personPut).toHaveBeenCalledWith(
      "occupancy",
      [claims],
      "claims",
      "space-12",
      record,
      2,
      identity,
    );
    expect(personGet).toHaveBeenCalledWith(
      "occupancy",
      [claims],
      "claims",
      "space-12",
    );
    expect(personDelete).toHaveBeenCalledWith(
      "occupancy",
      [claims],
      "claims",
      "space-12",
      3,
      identity,
    );
  });

  it("refuses records about a person to a plugin that was switched off", async () => {
    const { bound } = services();
    const get = vi.fn(async () => null);
    binding.bind({
      ...bound,
      personRecords: { get },
    } as unknown as PluginHostServices);
    const host = createPluginHost(binding, context);
    context.serving = false;

    await expect(
      host.personRecords.get("claims", "space-12"),
    ).rejects.toBeInstanceOf(PluginHostUnavailableError);
    expect(get).not.toHaveBeenCalled();
  });

  /**
   * ADR 0047: who is calling is the person core marked on the request, read
   * through the same mark as `actions`, and behind the address book's own
   * permission.
   */
  it("answers who is calling from the person the host marked on the request", async () => {
    const { bound } = services();
    const handle = {};
    const forPlugin = vi.fn(() => handle);
    const caller = vi.fn(async () => ({ kind: "notListed" as const }));
    binding.bind({
      ...bound,
      addressBook: { caller },
      callers: {
        forPlugin,
        resolve: () => ({ personId: "person-board" }),
      },
    } as unknown as PluginHostServices);
    const request = { id: "request-1" };

    await expect(
      runServingRequest(request, () =>
        createPluginHost(binding, context).addressBook.caller(request),
      ),
    ).resolves.toEqual({ kind: "notListed" });
    expect(forPlugin).toHaveBeenCalledWith(request, {
      id: "occupancy",
      ai: false,
    });
    expect(caller).toHaveBeenCalledWith("occupancy", "person-board", {
      contact: false,
    });

    await expect(
      runServingRequest(request, () =>
        createPluginHost(binding, {
          ...context,
          consented: [],
        }).addressBook.caller(request),
      ),
    ).rejects.toBeInstanceOf(PluginPermissionError);
  });

  /**
   * Switching a plugin off keeps its records and closes them to it, as every
   * other service is closed: a timer the plugin left running must not still
   * write.
   */
  it("refuses records to a plugin that was switched off", async () => {
    const { bound } = services();
    const put = vi.fn(async () => ({}));
    const get = vi.fn(async () => null);
    binding.bind({
      ...bound,
      records: { put, get },
    } as unknown as PluginHostServices);
    const host = createPluginHost(binding, context);
    context.serving = false;

    await expect(
      host.records.put("screens", "hall", { rotation: 10 }),
    ).rejects.toBeInstanceOf(PluginHostUnavailableError);
    await expect(host.records.get("screens", "hall")).rejects.toBeInstanceOf(
      PluginHostUnavailableError,
    );
    expect(put).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
  });

  /**
   * A theme install is its own permission, and the plugin's id is the host's
   * to supply. A plugin that could name another plugin here could install
   * over that plugin's themes and list them, which the source rule forbids.
   */
  it("refuses a theme install from a plugin that did not declare themes:install", async () => {
    const install = vi.fn();
    binding.bind({
      ...services().bound,
      themes: { install, list: vi.fn() },
    } as unknown as PluginHostServices);
    const host = createPluginHost(binding, context);

    await expect(
      host.themes.install({}, new Uint8Array(), { sha512: "x" }),
    ).rejects.toBeInstanceOf(PluginPermissionError);
    await expect(host.themes.list()).rejects.toBeInstanceOf(
      PluginPermissionError,
    );
    expect(install).not.toHaveBeenCalled();
  });

  it("installs a theme as the plugin it is, for the request it was given", async () => {
    const install = vi.fn(async () => ({
      id: "skogsglanta",
      version: "1.0.0",
      warnings: [],
    }));
    const list = vi.fn(async () => []);
    binding.bind({
      ...services().bound,
      themes: { install, list },
    } as unknown as PluginHostServices);
    const host = createPluginHost(binding, {
      ...context,
      consented: ["themes:install"],
    });
    const request = {};
    const archive = new Uint8Array([1, 2, 3]);

    await expect(
      runServingRequest(request, () =>
        host.themes.install(request, archive, { sha512: "sha512-abc" }),
      ),
    ).resolves.toMatchObject({ id: "skogsglanta" });
    await host.themes.list();

    expect(install).toHaveBeenCalledWith(
      { id: "occupancy", ai: false },
      request,
      archive,
      "sha512-abc",
    );
    expect(list).toHaveBeenCalledWith("occupancy");
  });
});

/**
 * Device tokens, as a plugin's host object hands them out (ADR 0031): bound to
 * the plugin's own id and its declared routes, and gated on its serving.
 */
describe("the host's device tokens", () => {
  const SIGNAGE: PluginManifest = {
    ...MANIFEST,
    id: "signage",
    permissions: [],
    deviceRoutes: [{ id: "screen", path: "screen" }],
  };
  const DEVICE = {
    id: "device-token-1",
    route: "screen",
    subject: "scr_1",
    label: "Entrance B",
    issuedAt: "2026-10-20T08:00:00.000Z",
    lastUsedAt: null,
    revokedAt: null,
  };

  function hostWith(devices: Record<string, unknown>, serving = true) {
    const binding = new PluginHostBinding();
    binding.bind({ devices } as unknown as PluginHostServices);
    return createPluginHost(binding, {
      manifest: SIGNAGE,
      consented: [],
      serving,
      bufferedActions: [],
      bufferedBlocks: [],
      bufferedExtensionPoints: [],
      bufferedContributions: [],
    });
  }

  it("issues for the plugin's own id and the routes its manifest declares", async () => {
    const issue = vi.fn(async () => ({ token: "obrf_dt_x", device: DEVICE }));
    const request = {};

    await runServingRequest(request, () =>
      hostWith({ issue }).devices.issue(request, {
        route: "screen",
        subject: "scr_1",
        label: "Entrance B",
      }),
    );

    expect(issue).toHaveBeenCalledWith("signage", ["screen"], request, {
      route: "screen",
      subject: "scr_1",
      label: "Entrance B",
    });
  });

  it("lists and revokes only the plugin's own tokens", async () => {
    const list = vi.fn(async () => []);
    const revokeForPlugin = vi.fn(async () => true);
    const host = hostWith({ list, revokeForPlugin });

    await host.devices.list({ route: "screen" });
    await host.devices.revoke("device-token-1");

    expect(list).toHaveBeenCalledWith("signage", { route: "screen" });
    expect(revokeForPlugin).toHaveBeenCalledWith(
      "signage",
      "device-token-1",
      undefined,
    );
  });

  it("refuses every call once the plugin has stopped serving", async () => {
    const issue = vi.fn();
    const host = hostWith({ issue }, false);

    await expect(
      host.devices.issue({}, { route: "screen", subject: "s", label: "l" }),
    ).rejects.toBeInstanceOf(PluginHostUnavailableError);
    expect(issue).not.toHaveBeenCalled();
  });

  it("names the device a request came from, on its own device route only", () => {
    const host = hostWith({});
    const own = {};
    markDeviceRequest(own, new LiveResponse(), {
      pluginId: "signage",
      device: DEVICE,
    });
    const another = {};
    markDeviceRequest(another, new LiveResponse(), {
      pluginId: "other",
      device: DEVICE,
    });

    expect(runServingRequest(own, () => host.devices.current(own))).toEqual(
      DEVICE,
    );
    // A request that reached another plugin's device route, or none at all,
    // each in the work serving it.
    expect(() =>
      runServingRequest(another, () => host.devices.current(another)),
    ).toThrow(/did not reach one of its device routes/);
    const none = {};
    expect(() =>
      runServingRequest(none, () => host.devices.current(none)),
    ).toThrow(/did not reach one of its device routes/);
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
      bufferedExtensionPoints: [],
      bufferedContributions: [],
    });
    const channels = () =>
      seen.map((caller) => callers.resolve(caller).channel);
    return { host: servingEach(host), channels };
  }

  function sessionRequest() {
    const held = { id: "req-1", principal: { personId: "person-1" } };
    markAuthenticated(held, new LiveResponse(), {
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
      bufferedExtensionPoints: [],
      bufferedContributions: [],
    });
    const recorded = () =>
      contexts.map((context) => auditActor(actorOf(context)));
    return { host: servingEach(host), recorded };
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
    markAuthenticated(held, new LiveResponse(), {
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
        pluginId: "occupancy",
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
        pluginId: "occupancy",
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
        pluginId: "occupancy",
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
        pluginId: "occupancy",
        pendingChangeId: null,
      },
    ]);
  });

  it("tells a plugin which connected app a request came from, as the guard established it", () => {
    const { host } = dispatching(MANIFEST);
    const app = { clientId: "client-1", clientHost: "claude.ai" };

    expect(host.actions.client(authenticated() as never)).toBeNull();
    expect(host.actions.client(authenticated(REAL_TOKEN) as never)).toEqual(
      app,
    );

    // What a connector checks before answering MCP, so writing on the request
    // must not move the answer either way.
    const session = authenticated();
    session.token = INVENTED_TOKEN;
    expect(host.actions.client(session as never)).toBeNull();

    const removed = authenticated(REAL_TOKEN);
    delete removed.token;
    expect(host.actions.client(removed as never)).toEqual(app);

    const replaced = authenticated(REAL_TOKEN);
    replaced.token = INVENTED_TOKEN;
    expect(host.actions.client(replaced as never)).toEqual(app);
  });

  it("refuses to name the app behind a request the platform did not authenticate", () => {
    const { host } = dispatching(MANIFEST);

    expect(() =>
      host.actions.client({ token: INVENTED_TOKEN } as never),
    ).toThrow("This is not a request the platform authenticated.");
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
        pluginId: "occupancy",
        pendingChangeId: null,
      },
    ]);
  });
});

/**
 * `host.entitlements` (ADR 0042): only on a plugin whose manifest declares a
 * licence, reading that declaration and nothing a plugin passes, and behind
 * the same gate as every other service.
 */
describe("the host's entitlements", () => {
  const AUDIENCE = "https://themes.example.org";
  const LICENSED: PluginManifest = {
    ...MANIFEST,
    licence: {
      entitlement: "themes",
      issuer: { name: "Test Issuer AB", url: "https://issuer.example" },
      keys: { "test-1": `${"A".repeat(42)}E=` },
      audiences: [AUDIENCE],
    },
    released: "2026-12-01",
  };

  function licensedHost(manifest: PluginManifest) {
    const binding = new PluginHostBinding();
    const context: PluginHostContext = {
      manifest,
      consented: [],
      serving: true,
      bufferedActions: [],
      bufferedBlocks: [],
      bufferedExtensionPoints: [],
      bufferedContributions: [],
    };
    const get = vi.fn(async () => ({ status: "absent" as const }));
    const present = vi.fn(async () => "presentation");
    binding.bind({
      ...services().bound,
      entitlements: { get, present },
    } as unknown as PluginHostServices);
    return { host: createPluginHost(binding, context), context, get, present };
  }

  it("is absent on a plugin whose manifest declares no licence", () => {
    expect(licensedHost(MANIFEST).host.entitlements).toBeUndefined();
  });

  it("judges the licence the manifest declares", async () => {
    const { host, get } = licensedHost(LICENSED);

    await expect(host.entitlements?.get()).resolves.toEqual({
      status: "absent",
    });
    expect(get).toHaveBeenCalledWith({
      licence: LICENSED.licence,
      released: "2026-12-01",
    });
  });

  it("presents only to an audience the manifest declares", async () => {
    const { host, present } = licensedHost(LICENSED);

    await expect(host.entitlements?.present(AUDIENCE)).resolves.toBe(
      "presentation",
    );
    await expect(
      host.entitlements?.present("https://elsewhere.example.org"),
    ).rejects.toBeInstanceOf(RangeError);
    expect(present).toHaveBeenCalledTimes(1);
  });

  it("answers nothing once the plugin stops serving", async () => {
    const { host, context } = licensedHost(LICENSED);
    context.serving = false;

    await expect(host.entitlements?.get()).rejects.toBeInstanceOf(
      PluginHostUnavailableError,
    );
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
  let notification: ReturnType<typeof vi.fn>;
  let charges: ReturnType<typeof vi.fn>;
  let charge: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    binding = new PluginHostBinding();
    context = {
      manifest: { ...MANIFEST, permissions: ["finances:read"] },
      consented: ["finances:read"],
      serving: true,
      bufferedActions: [],
      bufferedBlocks: [],
      bufferedExtensionPoints: [],
      bufferedContributions: [],
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
    notification = vi.fn(async () => null);
    charges = vi.fn(async () => []);
    charge = vi.fn(async () => null);
    binding.bind({
      ...services().bound,
      finances: {
        notifications,
        notification,
        charges,
        charge,
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

  it("reads as the plugin the host loaded, which decides whose references it is shown", async () => {
    const host = createPluginHost(binding, context);
    const period = { from: "2026-01-01", to: "2026-12-31" };

    await host.finances.notification("run-1");
    await host.finances.charges(period);
    await host.finances.charge("charge-1");

    expect(notification).toHaveBeenCalledWith(MANIFEST.id, "run-1");
    expect(charges).toHaveBeenCalledWith(MANIFEST.id, period);
    expect(charge).toHaveBeenCalledWith(MANIFEST.id, "charge-1");
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
describe("the plugin a dispatch is recorded as", () => {
  /*
   * ADR 0038, question 4. The caller handle names the plugin the host object
   * was built for, from its manifest, so the audit entry its dispatch writes
   * names it. Nothing the plugin passes reaches the name.
   */
  function host(): {
    plugin: ReturnType<typeof createPluginHost>;
    forPlugin: ReturnType<typeof vi.fn>;
  } {
    const forPlugin = vi.fn(() => ({}));
    const binding = new PluginHostBinding();
    binding.bind({
      ...services().bound,
      callers: { forPlugin },
      actions: {
        listWithSchemas: vi.fn(async () => []),
        invoke: vi.fn(async () => ({})),
        get: vi.fn(() => undefined),
      },
    } as unknown as PluginHostServices);
    const plugin = createPluginHost(binding, {
      manifest: MANIFEST,
      consented: ["addressBook:read"],
      serving: true,
      bufferedActions: [],
      bufferedBlocks: [],
      bufferedExtensionPoints: [],
      bufferedContributions: [],
    });
    return { plugin: servingEach(plugin), forPlugin };
  }

  it("names the plugin from its manifest when it invokes", async () => {
    const { plugin, forPlugin } = host();
    const request = {};

    await plugin.actions.invoke(request, "page_create", {
      pluginId: "someone-else",
    });

    expect(forPlugin).toHaveBeenCalledWith(request, {
      id: "occupancy",
      ai: false,
    });
  });

  it("names it the same way when it lists", async () => {
    const { plugin, forPlugin } = host();
    const request = {};

    await plugin.actions.list(request);

    expect(forPlugin).toHaveBeenCalledWith(request, {
      id: "occupancy",
      ai: false,
    });
  });
});

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
    return servingEach(
      createPluginHost(binding, {
        manifest: MANIFEST,
        consented: ["addressBook:read"],
        serving: true,
        bufferedActions: [],
        bufferedBlocks: [],
        bufferedExtensionPoints: [],
        bufferedContributions: [],
      }),
    );
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

  it.each([undefined, null])(
    "defaults the details to none when a handler's own details() answers %s",
    async (answer) => {
      const own = Object.assign(new Error("Closed."), {
        reason: "booking-closed",
        status: 409,
        details: () => answer,
      });
      const refused = await rejection(host(own));

      if (!isActionRefusal(refused)) {
        throw new Error("not a refusal");
      }
      expect(refused.details()).toEqual({});
    },
  );

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

/**
 * A request a plugin kept past its response.
 *
 * A plugin can hold on to the request a board member's visit handed it and
 * pass it again from a job, or while serving somebody else. The request is
 * real, so only its having been answered tells it apart, and the host refuses
 * it before the registry is asked anything: what the registry would decide
 * on, and what its audit entry would name as the actor, is the person who is
 * no longer there.
 */
describe("a request kept past its response", () => {
  function host(): {
    plugin: ReturnType<typeof createPluginHost>;
    invoke: ReturnType<typeof vi.fn>;
    list: ReturnType<typeof vi.fn>;
    record: ReturnType<typeof vi.fn>;
  } {
    const callers = new ActionCallerFactory();
    // The registry resolves the handle first, as the real one does.
    const invoke = vi.fn(async (caller: ActionCaller) => {
      return callers.resolve(caller).personId;
    });
    const list = vi.fn(async (caller: ActionCaller) => {
      callers.resolve(caller);
      return [];
    });
    const record = vi.fn(async () => undefined);
    const binding = new PluginHostBinding();
    binding.bind({
      ...services().bound,
      callers,
      actions: { invoke, listWithSchemas: list, get: vi.fn(() => null) },
      audit: { record },
    } as unknown as PluginHostServices);
    const plugin = createPluginHost(binding, {
      manifest: MANIFEST,
      consented: ["addressBook:read"],
      serving: true,
      bufferedActions: [],
      bufferedBlocks: [],
      bufferedExtensionPoints: [],
      bufferedContributions: [],
    });
    return { plugin: servingEach(plugin), invoke, list, record };
  }

  function served(response: LiveResponse): RequestWithToken {
    const request = {
      id: "req-1",
      principal: { personId: "board-member", capabilities: new Set() },
    } as unknown as RequestWithToken;
    markAuthenticated(request, response, {
      personId: "board-member",
      token: null,
      requestId: "req-1",
    });
    return request;
  }

  it("dispatches as the person while the response is still being served", async () => {
    const { plugin } = host();
    const request = served(new LiveResponse());

    await expect(plugin.actions.invoke(request, "summary", {})).resolves.toBe(
      "board-member",
    );
  });

  it("refuses host.actions.invoke once the response is sent", async () => {
    const { plugin, invoke } = host();
    const response = new LiveResponse();
    const kept = served(response);
    response.emit("finish");

    await expect(plugin.actions.invoke(kept, "summary", {})).rejects.toThrow(
      /has been answered/i,
    );
    expect(invoke).not.toHaveBeenCalled();
  });

  it("refuses host.actions.list once the response is sent", async () => {
    const { plugin, list } = host();
    const response = new LiveResponse();
    const kept = served(response);
    response.emit("finish");

    await expect(plugin.actions.list(kept)).rejects.toThrow(
      /has been answered/i,
    );
    expect(list).not.toHaveBeenCalled();
  });

  it("records the person as the actor while the response is still being served", async () => {
    const { plugin, record } = host();
    const request = served(new LiveResponse());

    await plugin.audit.record(request, { event: "screen.residents-enabled" });

    expect(record).toHaveBeenCalledWith(
      "occupancy",
      { personId: "board-member", clientId: null, clientHost: null },
      { event: "screen.residents-enabled" },
    );
  });

  it("refuses host.audit.record once the response is sent, and writes nothing", async () => {
    // The entry would name the board member as the actor of something they
    // never did, and it would be on their access report.
    const { plugin, record } = host();
    const response = new LiveResponse();
    const kept = served(response);
    response.emit("finish");

    await expect(
      plugin.audit.record(kept, { event: "screen.residents-enabled" }),
    ).rejects.toThrow(/has been answered/i);
    expect(record).not.toHaveBeenCalled();
  });
});

/**
 * An audit entry written on a device's request (L-1 of the #557 review).
 *
 * A device names nobody, so the entry has no actor, and the device spends a
 * budget of its own that refuses past it: with only `null` to write on, every
 * call a device made would spend the budget that stops the plugin, and whoever
 * holds a screen's token could stop the plugin for everyone.
 */
describe("an audit entry on a device's request", () => {
  const SIGNAGE: PluginManifest = {
    ...MANIFEST,
    id: "signage",
    permissions: [],
    deviceRoutes: [{ id: "screen", path: "screen" }],
  };
  const ENTRY = { event: "screen.shown" };

  function device(id: string) {
    return {
      id,
      route: "screen",
      subject: "scr_1",
      label: "Entrance B",
      issuedAt: "2026-10-20T08:00:00.000Z",
      lastUsedAt: null,
      revokedAt: null,
    };
  }

  function host(): {
    plugin: ReturnType<typeof createPluginHost>;
    write: ReturnType<typeof vi.fn>;
    refuse: ReturnType<typeof vi.fn>;
  } {
    const write = vi.fn(async () => undefined);
    const refuse = vi.fn();
    const binding = new PluginHostBinding();
    binding.bind({
      ...services().bound,
      callers: new ActionCallerFactory(),
      audit: new PluginAuditService(
        { record: write } as unknown as AuditLogService,
        { refuse } as unknown as PluginLoaderService,
      ),
    } as unknown as PluginHostServices);
    const plugin = createPluginHost(binding, {
      manifest: SIGNAGE,
      consented: [],
      serving: true,
      bufferedActions: [],
      bufferedBlocks: [],
      bufferedExtensionPoints: [],
      bufferedContributions: [],
    });
    return { plugin: servingEach(plugin), write, refuse };
  }

  function onDevice(
    response: LiveResponse,
    tokenId = "device-token-1",
    pluginId = "signage",
  ): object {
    const request = {};
    markDeviceRequest(request, response, {
      pluginId,
      device: device(tokenId),
    });
    return request;
  }

  afterEach(() => {
    vi.useRealTimers();
  });

  it("writes the entry with no actor", async () => {
    const { plugin, write } = host();

    await plugin.audit.record(onDevice(new LiveResponse()), ENTRY);

    expect(write).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        action: "PLUGIN_RECORDED",
        actorPersonId: null,
        clientId: null,
        clientHost: null,
        targetId: "signage",
        context: { event: "screen.shown" },
      }),
    );
  });

  it("refuses the device's entries past its budget and never stops the plugin", async () => {
    vi.useFakeTimers({ now: new Date("2026-10-23T10:00:00Z") });
    const { plugin, write, refuse } = host();
    const request = onDevice(new LiveResponse());
    const refusals: unknown[] = [];

    // Past the plugin's own budget too, which a device would have spent had
    // it been written as an entry with no request.
    for (
      let attempt = 0;
      attempt <= PLUGIN_AUDIT_LIMITS.perMinute;
      attempt += 1
    ) {
      await plugin.audit.record(request, ENTRY).catch((error: unknown) => {
        refusals.push(error);
      });
    }

    expect(write).toHaveBeenCalledTimes(PLUGIN_AUDIT_LIMITS.perDevicePerMinute);
    expect(refusals).toHaveLength(
      PLUGIN_AUDIT_LIMITS.perMinute +
        1 -
        PLUGIN_AUDIT_LIMITS.perDevicePerMinute,
    );
    for (const refusal of refusals) {
      expect(refusal).toBeInstanceOf(PluginAuditRateError);
      expect((refusal as Error).message).not.toContain("device-token-1");
    }
    expect(refuse).not.toHaveBeenCalled();
    // Still serving: the plugin's own budget is whole.
    for (let index = 0; index < PLUGIN_AUDIT_LIMITS.perMinute; index += 1) {
      await plugin.audit.record(null, ENTRY);
    }
    expect(refuse).not.toHaveBeenCalled();
  });

  it("keeps the device's budget when the plugin rewrites the summary it was handed", async () => {
    // The budget is keyed on the token's id, and `host.devices.current`
    // hands out the summary that holds it: a new id before every entry would
    // otherwise be a new device with a whole budget each time.
    vi.useFakeTimers({ now: new Date("2026-10-23T10:00:00Z") });
    const { plugin, write, refuse } = host();
    const request = onDevice(new LiveResponse());
    const refusals: unknown[] = [];

    for (
      let attempt = 0;
      attempt <= PLUGIN_AUDIT_LIMITS.perMinute;
      attempt += 1
    ) {
      const summary = plugin.devices.current(request);
      expect(Reflect.set(summary, "id", `forged-${attempt}`)).toBe(false);
      await plugin.audit.record(request, ENTRY).catch((error: unknown) => {
        refusals.push(error);
      });
    }

    expect(plugin.devices.current(request).id).toBe("device-token-1");
    expect(write).toHaveBeenCalledTimes(PLUGIN_AUDIT_LIMITS.perDevicePerMinute);
    expect(refusals).toHaveLength(
      PLUGIN_AUDIT_LIMITS.perMinute +
        1 -
        PLUGIN_AUDIT_LIMITS.perDevicePerMinute,
    );
    expect(refuse).not.toHaveBeenCalled();
  });

  it("refills the device's budget", async () => {
    vi.useFakeTimers({ now: new Date("2026-10-23T10:00:00Z") });
    const { plugin, write } = host();
    const request = onDevice(new LiveResponse());
    for (
      let index = 0;
      index < PLUGIN_AUDIT_LIMITS.perDevicePerMinute;
      index += 1
    ) {
      await plugin.audit.record(request, ENTRY);
    }
    await expect(plugin.audit.record(request, ENTRY)).rejects.toThrow(
      PluginAuditRateError,
    );

    vi.advanceTimersByTime(60_000);

    await expect(plugin.audit.record(request, ENTRY)).resolves.toBeUndefined();
    expect(write).toHaveBeenCalledTimes(
      PLUGIN_AUDIT_LIMITS.perDevicePerMinute + 1,
    );
  });

  it("gives each device a budget of its own", async () => {
    vi.useFakeTimers({ now: new Date("2026-10-23T10:00:00Z") });
    const { plugin, write } = host();
    const first = onDevice(new LiveResponse(), "device-token-1");
    const second = onDevice(new LiveResponse(), "device-token-2");
    for (
      let index = 0;
      index < PLUGIN_AUDIT_LIMITS.perDevicePerMinute;
      index += 1
    ) {
      await plugin.audit.record(first, ENTRY);
    }
    await expect(plugin.audit.record(first, ENTRY)).rejects.toThrow(
      PluginAuditRateError,
    );

    await expect(plugin.audit.record(second, ENTRY)).resolves.toBeUndefined();
    expect(write).toHaveBeenCalledTimes(
      PLUGIN_AUDIT_LIMITS.perDevicePerMinute + 1,
    );
  });

  it("refuses a device's request once the response is sent, and writes nothing", async () => {
    // A kept request would otherwise let a job write on it, refused past the
    // device's budget rather than stopped past the plugin's own.
    const { plugin, write } = host();
    const response = new LiveResponse();
    const kept = onDevice(response);
    response.emit("close");

    await expect(plugin.audit.record(kept, ENTRY)).rejects.toThrow(
      /has been answered/i,
    );
    expect(write).not.toHaveBeenCalled();
  });

  it("refuses a request that reached another plugin's device route, and one nobody marked", async () => {
    const { plugin, write } = host();

    await expect(
      plugin.audit.record(
        onDevice(new LiveResponse(), "device-token-1", "other"),
        ENTRY,
      ),
    ).rejects.toThrow(/not a request the platform authenticated/i);
    await expect(plugin.audit.record({}, ENTRY)).rejects.toThrow(
      /not a request the platform authenticated/i,
    );
    expect(write).not.toHaveBeenCalled();
  });

  it("keeps spending a person's budget on a person's request", async () => {
    vi.useFakeTimers({ now: new Date("2026-10-23T10:00:00Z") });
    const { plugin, write, refuse } = host();
    const request = {};
    markAuthenticated(request, new LiveResponse(), {
      personId: "board-member",
      token: null,
      requestId: "req-1",
    });
    for (
      let index = 0;
      index < PLUGIN_AUDIT_LIMITS.perPersonPerMinute;
      index += 1
    ) {
      await plugin.audit.record(request, ENTRY);
    }

    const refused = await plugin.audit.record(request, ENTRY).then(
      () => null,
      (error: unknown) => error,
    );

    expect(refused).toBeInstanceOf(PluginAuditRateError);
    expect((refused as Error).message).toMatch(/one person's requests/);
    expect(write).toHaveBeenLastCalledWith(
      expect.objectContaining({ actorPersonId: "board-member" }),
    );
    // The device's budget is untouched by the person's entries.
    await expect(
      plugin.audit.record(onDevice(new LiveResponse()), ENTRY),
    ).resolves.toBeUndefined();
    expect(refuse).not.toHaveBeenCalled();
  });
});

/**
 * ADR 0051: on a resident route the host refuses the register reads and holds
 * `caller`, the action dispatch and the audit entry's actor to the request the
 * route is serving. A board member's request a plugin kept in a singleton is
 * still being served, so its mark still names them; it is refused here.
 */
describe("the host object on a resident route", () => {
  function host(id = MANIFEST.id) {
    const callers = new ActionCallerFactory();
    const bound = services();
    const caller = vi.fn(async () => ({ kind: "notListed" as const }));
    const list = vi.fn(async (actionCaller: ActionCaller) => {
      callers.resolve(actionCaller);
      return [];
    });
    const invoke = vi.fn(async (actionCaller: ActionCaller) => {
      return callers.resolve(actionCaller).personId;
    });
    const propose = vi.fn(async () => ({
      id: "change-1",
      expiresAt: "2026-10-28T00:00:00.000Z",
    }));
    const record = vi.fn(async () => undefined);
    const binding = new PluginHostBinding();
    binding.bind({
      ...bound.bound,
      addressBook: {
        residents: bound.residents,
        summary: bound.summary,
        apartments: vi.fn(async () => []),
        caller,
      },
      callers,
      actions: { invoke, listWithSchemas: list, get: vi.fn(() => null) },
      pendingChanges: { propose },
      audit: { record },
    } as unknown as PluginHostServices);
    const plugin = createPluginHost(binding, {
      manifest: { ...MANIFEST, id },
      consented: ["addressBook:read"],
      serving: true,
      bufferedActions: [],
      bufferedBlocks: [],
      bufferedExtensionPoints: [],
      bufferedContributions: [],
    });
    return {
      plugin,
      residents: bound.residents,
      caller,
      list,
      invoke,
      propose,
      record,
    };
  }

  function served(personId: string): RequestWithToken {
    const request = {
      id: `req-${personId}`,
      principal: { personId, capabilities: new Set() },
    } as unknown as RequestWithToken;
    markAuthenticated(request, new LiveResponse(), {
      personId,
      token: null,
      requestId: request.id as string,
    });
    return request;
  }

  const resident = served("resident");
  const board = served("board-member");
  // Served as the router serves it: in the request's own work, and in the
  // resident route's scope the route interceptor opens inside that.
  const onRoute = <T>(work: () => T): T =>
    runServingRequest(resident, () =>
      runOnResidentRoute(
        { pluginId: MANIFEST.id, request: resident, personId: "resident" },
        work,
      ),
    );

  it("refuses the register reads, and reads nothing", async () => {
    const { plugin, residents } = host();

    for (const [member, read] of [
      ["addressBook.residents", () => plugin.addressBook.residents()],
      ["addressBook.apartments", () => plugin.addressBook.apartments()],
      ["addressBook.summary", () => plugin.addressBook.summary()],
    ] as const) {
      await expect(
        onRoute(read as () => Promise<unknown>),
      ).rejects.toMatchObject({
        name: "PluginResidentRouteError",
        member,
      });
    }
    expect(residents).not.toHaveBeenCalled();
    await expect(plugin.addressBook.residents()).resolves.toEqual([]);
  });

  it("answers caller for the request the route is serving and no other", async () => {
    const { plugin, caller } = host();

    await expect(
      onRoute(() => plugin.addressBook.caller(resident)),
    ).resolves.toEqual({ kind: "notListed" });
    await expect(
      onRoute(() => plugin.addressBook.caller(board)),
    ).rejects.toEqual(
      new PluginResidentRouteError(MANIFEST.id, "addressBook.caller"),
    );
    expect(caller).toHaveBeenCalledTimes(1);
    expect(caller).toHaveBeenCalledWith(MANIFEST.id, "resident", {
      contact: false,
    });
  });

  it("dispatches only with the request the route is serving", async () => {
    const { plugin, list } = host();

    await expect(onRoute(() => plugin.actions.list(resident))).resolves.toEqual(
      [],
    );
    await expect(
      onRoute(() => plugin.actions.invoke(resident, "summary", {})),
    ).resolves.toBe("resident");
    for (const [member, dispatch] of [
      ["actions.list", () => plugin.actions.list(board)],
      ["actions.invoke", () => plugin.actions.invoke(board, "summary", {})],
      ["actions.propose", () => plugin.actions.propose(board, "summary", {})],
    ] as const) {
      await expect(onRoute(dispatch)).rejects.toMatchObject({
        name: "PluginResidentRouteError",
        member,
      });
    }
    expect(list).toHaveBeenCalledTimes(1);
  });

  it("records an entry's actor only from the request the route is serving", async () => {
    const { plugin, record } = host();

    await onRoute(() => plugin.audit.record(resident, { event: "offer.made" }));
    await onRoute(() => plugin.audit.record(null, { event: "offer.made" }));
    await expect(
      onRoute(() => plugin.audit.record(board, { event: "offer.made" })),
    ).rejects.toMatchObject({
      name: "PluginResidentRouteError",
      member: "audit.record",
    });
    expect(record).toHaveBeenCalledTimes(2);
  });

  describe("off the route, while its handler works", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    /**
     * Serves a resident route whose handler awaits a listener on a Subject the
     * plugin shares, `firstValueFrom(events.pipe(mergeMap(async () => ...)))`:
     * `emit` runs the listener as a job emitting would, outside the scope and
     * serving no request, or, given one, as that request's own work emitting
     * would.
     */
    function awaitingListener(listener: () => Promise<unknown>) {
      let heard = (_listened: Promise<unknown>): void => undefined;
      const listened = new Promise<unknown>((resolve) => {
        heard = resolve;
      });
      const answer = onRoute(() =>
        residentRouteHandler(MANIFEST.id, async () => {
          await listened;
          return { done: true };
        })(),
      ) as Promise<unknown>;
      return {
        answer,
        emit: (servedBy?: object) => {
          // The listener runs where the value was emitted, not in the scope,
          // and the handler awaits what it does.
          const running =
            servedBy === undefined
              ? listener()
              : runServingRequest(servedBy, listener);
          heard(running);
          return running;
        },
      };
    }

    it("never dispatches or records with the board request whose work runs a listener the handler awaits", async () => {
      vi.useFakeTimers();
      const { plugin, invoke, propose, list, record, residents, caller } =
        host();
      const outcomes: unknown[] = [];
      const { emit } = awaitingListener(async () => {
        const calls = [
          () => plugin.audit.record(board, { event: "offer.viewed" }),
          () =>
            plugin.audit.record(null, {
              event: "offer.viewed",
              subject: "neighbour",
            }),
          () => plugin.actions.invoke(board, "summary", {}),
          () => plugin.actions.propose(board, "summary", {}),
          () => plugin.actions.list(board),
          () => plugin.addressBook.caller(board),
          () => plugin.addressBook.residents(),
        ];
        for (const call of calls) {
          outcomes.push(await call().catch((cause: unknown) => cause));
        }
      });

      // The board request is the one its own work serves, so only the hold
      // stands between the listener and the handler's answer.
      const listened = emit(board);
      await vi.advanceTimersByTimeAsync(7 * RESIDENT_ROUTE_ANSWER_WAIT_MS);
      await listened;

      expect(outcomes).toEqual(
        [
          "audit.record",
          "audit.record",
          "actions.invoke",
          "actions.propose",
          "actions.list",
          "addressBook.caller",
          "addressBook.residents",
        ].map(
          (member) =>
            new PluginResidentRouteError(
              MANIFEST.id,
              member as PluginResidentRouteRefusedMember,
              true,
            ),
        ),
      );
      for (const backend of [
        invoke,
        propose,
        list,
        record,
        residents,
        caller,
      ]) {
        expect(backend).not.toHaveBeenCalled();
      }
    });

    it("refuses a kept board request at once from a listener a job runs, and holds the rest", async () => {
      vi.useFakeTimers();
      const { plugin, invoke, propose, list, record, residents, caller } =
        host();
      const outcomes: unknown[] = [];
      const { emit } = awaitingListener(async () => {
        const calls = [
          () => plugin.audit.record(board, { event: "offer.viewed" }),
          () => plugin.actions.invoke(board, "summary", {}),
          () => plugin.actions.propose(board, "summary", {}),
          () => plugin.actions.list(board),
          () => plugin.addressBook.caller(board),
        ];
        for (const call of calls) {
          outcomes.push(await call().catch((cause: unknown) => cause));
        }
      });

      // Nothing waits: the job serves no request, so the board's is refused
      // before the hold is asked.
      await emit();

      expect(outcomes).toEqual(
        [
          "audit.record",
          "actions.invoke",
          "actions.propose",
          "actions.list",
          "addressBook.caller",
        ].map(
          (member) =>
            new PluginRequestContextError(
              MANIFEST.id,
              member as PluginRequestMember,
            ),
        ),
      );
      for (const backend of [
        invoke,
        propose,
        list,
        record,
        residents,
        caller,
      ]) {
        expect(backend).not.toHaveBeenCalled();
      }
    });

    it("dispatches and records a board route's own call once the handler has answered", async () => {
      const { plugin, invoke, record } = host();
      const { answer, emit } = awaitingListener(async () => undefined);

      // The board route's own call, in its own work, not one the handler
      // awaits.
      const dispatched = runServingRequest(board, () =>
        plugin.actions.invoke(board, "summary", {}),
      );
      const recorded = runServingRequest(board, () =>
        plugin.audit.record(board, { event: "offer.viewed" }),
      );
      await Promise.resolve();
      expect(invoke).not.toHaveBeenCalled();
      expect(record).not.toHaveBeenCalled();
      await emit();

      await expect(answer).resolves.toEqual({ done: true });
      await expect(dispatched).resolves.toBe("board-member");
      await recorded;
      expect(record).toHaveBeenCalledTimes(1);
    });

    it("refuses a board route's own call whose response ended while it waited for the handler's answer", async () => {
      const { plugin, invoke, propose, list, record, caller } = host();
      const { answer, emit } = awaitingListener(async () => undefined);

      const { result: waiting, end } = servingUntilAnswered(board, () =>
        Promise.all(
          [
            () => plugin.audit.record(board, { event: "offer.viewed" }),
            () => plugin.actions.invoke(board, "summary", {}),
            () => plugin.actions.propose(board, "summary", {}),
            () => plugin.actions.list(board),
            () => plugin.addressBook.caller(board),
          ].map((call) => call().catch((cause: unknown) => cause)),
        ),
      );
      await Promise.resolve();
      // The board's client leaves before the resident route answers.
      end();
      await emit();

      await expect(answer).resolves.toEqual({ done: true });
      expect(await waiting).toEqual(
        [
          "audit.record",
          "actions.invoke",
          "actions.propose",
          "actions.list",
          "addressBook.caller",
        ].map(
          (member) =>
            new PluginRequestContextError(
              MANIFEST.id,
              member as PluginRequestMember,
            ),
        ),
      );
      for (const backend of [invoke, propose, list, record, caller]) {
        expect(backend).not.toHaveBeenCalled();
      }
    });
  });

  it("leaves another plugin's host object alone inside the scope", async () => {
    const { plugin } = host("another-plugin");

    await expect(
      onRoute(() => plugin.addressBook.residents()),
    ).resolves.toEqual([]);
    await expect(onRoute(() => plugin.actions.list(resident))).resolves.toEqual(
      [],
    );
    // Held to the request the work serves, as on any route, and not refused
    // as the resident route refuses it.
    await expect(onRoute(() => plugin.actions.list(board))).rejects.toEqual(
      new PluginRequestContextError("another-plugin", "actions.list"),
    );
  });
});

import {
  RECEIVING_HOSTS_MAX_LENGTH,
  receivingHosts,
} from "@openbrf/plugin-sdk";
import { DATA_PROTECTION_LIMITS } from "@openbrf/shared";
import { describe, expect, it, vi } from "vite-plus/test";

import type { RequestWithPrincipal } from "../authorization/authorization.guard";
import type { PluginAdminService } from "./plugin-admin.service";
import { PluginsWriteController } from "./plugins.controller";

/**
 * What survives the parse on the way into an install.
 *
 * The consent echo is the control that stops a board installing on the strength
 * of a screen the catalog has since changed under. It only works if what the
 * browser sends actually reaches the comparison: a field the request schema
 * does not name is stripped by zod before the service sees it, and the service
 * then compares the catalog's declaration against nothing. That failure is
 * silent in exactly the wrong direction - every install of a plugin declaring
 * an action is refused, and no test over the service or the registry can see it
 * because the loss happens above them.
 */

function build() {
  const install = vi.fn(async () => ({ restarting: false }));
  const controller = new PluginsWriteController({
    install,
  } as unknown as PluginAdminService);
  const request = {
    principal: { personId: "board-1" },
  } as unknown as RequestWithPrincipal;
  return { controller, install, request };
}

const DECLARED = [
  {
    id: "summary",
    capability: "self:manage",
    effect: "read" as const,
    personalData: ["name" as const],
    surfaces: ["ui" as const, "mcp" as const],
  },
];

describe("the body an install is parsed from", () => {
  it("carries the declared actions through to the service", async () => {
    /*
     * The whole of this case. The browser sends what the consent screen showed,
     * and all three lists have to arrive: the service compares them as one, so
     * actions arriving as undefined reads as a board that consented to no
     * action at all - and a plugin that declares one is then refused with a
     * consent mismatch it can never satisfy.
     */
    const { controller, install, request } = build();

    await controller.install(request, {
      id: "occupancy",
      permissions: ["addressBook:read"],
      personalData: ["name"],
      actions: DECLARED,
      recipients: [],
      deviceRoutes: [],
    });

    expect(install).toHaveBeenCalledTimes(1);
    const [parsed] = install.mock.calls[0] as unknown as [
      { actions?: unknown[] },
    ];
    expect(parsed.actions).toEqual(DECLARED);
  });

  it("refuses a body that echoes the other two and omits the actions", async () => {
    /*
     * Required rather than defaulted, which is the difference between a refusal
     * a caller can read and one it cannot. A default would put an empty list
     * back, the service would compare the catalog's declarations against it,
     * and the answer would be a consent mismatch - telling a board the entry
     * changed under them when what happened is that their client sent two
     * thirds of the echo.
     *
     * The command-line path does not come through here: it calls the service
     * directly, where the three are optional because running the command is
     * itself the consent.
     */
    const { controller, install, request } = build();

    await expect(
      controller.install(request, {
        id: "occupancy",
        permissions: ["addressBook:read"],
        personalData: ["name"],
      }),
    ).rejects.toThrow();
    expect(install).not.toHaveBeenCalled();
  });

  it("refuses an action declaration that is not one", async () => {
    // Named in the schema means checked by it: a body inventing an effect the
    // contract has no value for is a 400 rather than a row.
    const { controller, request } = build();

    await expect(
      controller.install(request, {
        id: "occupancy",
        permissions: ["addressBook:read"],
        personalData: ["name"],
        actions: [
          { id: "summary", capability: "self:manage", effect: "obliterate" },
        ],
      }),
    ).rejects.toThrow();
  });

  it("refuses two declarations wearing one id", async () => {
    // The manifest's own rule, reaching this boundary through the same schema:
    // an echo the catalog could never have shown is not an echo.
    const { controller, request } = build();

    await expect(
      controller.install(request, {
        id: "occupancy",
        permissions: ["addressBook:read"],
        personalData: ["name"],
        actions: [DECLARED[0], { ...DECLARED[0], capability: "site:manage" }],
      }),
    ).rejects.toThrow();
  });
});

/**
 * The same rule, for the route a connector declares.
 *
 * It travels for the reason the three lists above do, and it is the one field
 * where a silent loss is not a refusal but the opposite: the route decides
 * which address connected apps sign in to, so an echo stripped on the way in
 * would let a board confirm a screen that never mentioned it.
 */
describe("whether an install body says the screen showed an AI package", () => {
  it("carries it through to the service", async () => {
    const { controller, install, request } = build();

    await controller.install(request, {
      id: "assistant",
      permissions: [],
      personalData: [],
      actions: [],
      recipients: [],
      deviceRoutes: [],
      ai: true,
    });

    const [parsed] = install.mock.calls[0] as unknown as [{ ai?: unknown }];
    expect(parsed.ai).toBe(true);
  });

  it("refuses a value that is not a yes or a no", async () => {
    const { controller, install, request } = build();

    await expect(
      controller.install(request, {
        id: "assistant",
        permissions: [],
        personalData: [],
        actions: [],
        recipients: [],
        deviceRoutes: [],
        ai: "yes",
      }),
    ).rejects.toThrow();
    expect(install).not.toHaveBeenCalled();
  });
});

describe("the connected-app sign-in route in an install body", () => {
  it("carries the route the consent screen showed", async () => {
    const { controller, install, request } = build();

    await controller.install(request, {
      id: "connector",
      permissions: [],
      personalData: [],
      actions: [],
      recipients: [],
      deviceRoutes: [],
      oauthProtectedResource: "mcp",
    });

    const [parsed] = install.mock.calls[0] as unknown as [
      { oauthProtectedResource?: unknown },
    ];
    expect(parsed.oauthProtectedResource).toBe("mcp");
  });

  it("carries the statement that the screen showed no such route", async () => {
    const { controller, install, request } = build();

    await controller.install(request, {
      id: "occupancy",
      permissions: [],
      personalData: [],
      actions: [],
      recipients: [],
      deviceRoutes: [],
      oauthProtectedResource: null,
    });

    const [parsed] = install.mock.calls[0] as unknown as [
      { oauthProtectedResource?: unknown },
    ];
    // Null rather than stripped: the comparison has to be able to tell "the
    // screen showed none" from "the field never arrived".
    expect(parsed.oauthProtectedResource).toBeNull();
  });

  it("refuses a route a manifest could not have declared", async () => {
    const { controller, install, request } = build();

    // Parsed with the manifest's own schema, so an echo cannot name an address
    // outside the plugin's own mount.
    await expect(
      controller.install(request, {
        id: "connector",
        permissions: [],
        personalData: [],
        actions: [],
        deviceRoutes: [],
        oauthProtectedResource: "../../admin",
      }),
    ).rejects.toThrow();
    expect(install).not.toHaveBeenCalled();
  });
});

/**
 * The recipients the consent screen showed (ADR 0037), on the terms of the
 * actions: named in the schema so they arrive, required so a body that left
 * them out is refused as one rather than read as consent to none.
 */
describe("the recipients in an install body", () => {
  const recipient = {
    id: "model-provider",
    origin: "https://api.anthropic.com",
    purpose: { sv: "Språkmodellen", en: "The language model" },
    personalData: ["freeText"],
  };
  const body = {
    id: "assistant",
    permissions: [],
    personalData: ["freeText"],
    actions: [],
    deviceRoutes: [],
  };

  it("carries them through to the service", async () => {
    const { controller, install, request } = build();

    await controller.install(request, { ...body, recipients: [recipient] });

    const [parsed] = install.mock.calls[0] as unknown as [
      { recipients?: unknown[] },
    ];
    expect(parsed.recipients).toEqual([recipient]);
  });

  it.each([
    ["leaves them out", {}],
    [
      "names an origin a manifest could not declare",
      { recipients: [{ ...recipient, origin: "http://api.anthropic.com" }] },
    ],
  ])("refuses a body that %s", async (_label, change) => {
    const { controller, install, request } = build();

    await expect(
      controller.install(request, { ...body, ...change }),
    ).rejects.toThrow();
    expect(install).not.toHaveBeenCalled();
  });

  /*
   * The consent screen fills the recipient in from every declared recipient
   * that receives personal data, so the answer is as long as the declaration
   * allows it to be. Eight ordinary hosts are already longer than a field
   * sized for one name.
   */
  it("takes the recipient answer every declared host fills in", async () => {
    const { controller, install, request } = build();
    const recipients = Array.from({ length: 8 }, (_, index) => ({
      ...recipient,
      personalData: ["freeText" as const],
      id: `provider-${String(index)}`,
      origin: `https://model-inference-provider-${String(index)}.example.com`,
    }));
    const answer = receivingHosts(recipients);
    expect(answer.length).toBeGreaterThan(300);

    await controller.install(request, {
      ...body,
      recipients,
      processorAgreement: {
        sendsPersonalDataOutside: true,
        recipient: answer,
        classification: "PROCESSOR",
      },
    });

    const [parsed] = install.mock.calls[0] as unknown as [
      { processorAgreement?: { recipient?: string } },
    ];
    expect(parsed.processorAgreement?.recipient).toBe(answer);
  });

  // The record's bound holds the longest answer a valid declaration fills in,
  // so no declaration the catalog accepts can fill in one this route refuses.
  it("bounds the answer no shorter than the longest declaration fills in", () => {
    expect(DATA_PROTECTION_LIMITS.recipientText).toBeGreaterThanOrEqual(
      RECEIVING_HOSTS_MAX_LENGTH,
    );
  });
});

/** The same rule, for the device routes the consent screen showed (ADR 0031). */
describe("the device routes in an install body", () => {
  it("carries the routes the consent screen showed", async () => {
    const { controller, install, request } = build();

    await controller.install(request, {
      id: "signage",
      permissions: [],
      personalData: [],
      actions: [],
      recipients: [],
      deviceRoutes: [{ id: "screen", path: "screen" }],
    });

    const [parsed] = install.mock.calls[0] as unknown as [
      { deviceRoutes?: unknown },
    ];
    expect(parsed.deviceRoutes).toEqual([{ id: "screen", path: "screen" }]);
  });

  it("refuses a body that omits them, rather than reading consent to none", async () => {
    const { controller, install, request } = build();

    await expect(
      controller.install(request, {
        id: "signage",
        permissions: [],
        personalData: [],
        actions: [],
        recipients: [],
      }),
    ).rejects.toThrow();
    expect(install).not.toHaveBeenCalled();
  });

  it("refuses a route a manifest could not have declared", async () => {
    const { controller, install, request } = build();

    await expect(
      controller.install(request, {
        id: "signage",
        permissions: [],
        personalData: [],
        actions: [],
        recipients: [],
        deviceRoutes: [{ id: "screen", path: "../../api/news" }],
      }),
    ).rejects.toThrow();
    expect(install).not.toHaveBeenCalled();
  });
});

/** The same rule, for the processing the consent screen showed (ADR 0035). */
describe("the processing in an install body", () => {
  const processing = {
    purpose: { sv: "Visa beläggningen.", en: "Show the occupancy." },
    legalBasis: "legitimateInterest" as const,
    legitimateInterest: { sv: "Överblick.", en: "An overview." },
    retention: { sv: "Sparas inte.", en: "Not kept." },
    dataSubjects: ["residents" as const],
  };
  const body = {
    id: "occupancy",
    permissions: ["addressBook:read"],
    personalData: ["name"],
    actions: [],
    recipients: [],
    deviceRoutes: [],
  };

  it("carries the declaration the consent screen showed", async () => {
    const { controller, install, request } = build();

    await controller.install(request, { ...body, processing });

    const [parsed] = install.mock.calls[0] as unknown as [
      { processing?: unknown },
    ];
    expect(parsed.processing).toEqual(processing);
  });

  it("carries null, the screen having shown none", async () => {
    const { controller, install, request } = build();

    await controller.install(request, { ...body, processing: null });

    const [parsed] = install.mock.calls[0] as unknown as [
      { processing?: unknown },
    ];
    expect(parsed.processing).toBeNull();
  });

  it("refuses a declaration a manifest could not have made", async () => {
    const { controller, install, request } = build();

    await expect(
      controller.install(request, {
        ...body,
        processing: { ...processing, legitimateInterest: undefined },
      }),
    ).rejects.toThrow();
    expect(install).not.toHaveBeenCalled();
  });
});

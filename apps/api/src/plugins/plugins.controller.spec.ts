import { describe, expect, it, vi } from "vitest";

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

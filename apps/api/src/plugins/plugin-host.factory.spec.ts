import type { PluginPermission } from "@openbrf/plugin-sdk";
import { describe, expect, it } from "vitest";

import { routeCapabilityFloor } from "./plugin-host.factory";

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
    // Sending mail and running jobs reach nothing the caller of a route could
    // read back, so gating those routes above self:manage would lock residents
    // out of plugins written for them.
    expect(routeCapabilityFloor(["mail:send"])).toBe("self:manage");
    expect(routeCapabilityFloor(["jobs:schedule"])).toBe("self:manage");
    expect(routeCapabilityFloor(["mail:send", "jobs:schedule"])).toBe(
      "self:manage",
    );
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

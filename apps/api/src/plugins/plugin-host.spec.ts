import type { PluginManifest, PluginPermission } from "@openbrf/plugin-sdk";
import {
  PluginHostUnavailableError,
  PluginPermissionError,
} from "@openbrf/plugin-sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";

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
};

/** A double for each application service, with the address book spied on. */
function services(): {
  bound: PluginHostServices;
  residents: ReturnType<typeof vi.fn>;
} {
  const residents = vi.fn(async () => []);
  return {
    residents,
    bound: {
      registry: { find: vi.fn(async () => null) },
      jobs: { send: vi.fn(async () => undefined) },
      mail: { send: vi.fn(async () => undefined) },
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

  it("logs before the application has started", () => {
    // The one service that must work at any moment, including from the
    // constructor that is about to fail.
    const host = createPluginHost(binding, context);

    expect(() => {
      host.logger.info("starting");
    }).not.toThrow();
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

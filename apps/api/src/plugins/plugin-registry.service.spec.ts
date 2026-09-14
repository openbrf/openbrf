import { describe, expect, it, vi } from "vitest";

import type { PrismaService } from "../database/prisma.service";
import { PluginRegistryService } from "./plugin-registry.service";

/**
 * Arming, which is the decision that offers an action beyond this instance.
 *
 * Declaring an action is a proposal the board consents to at install; arming is
 * a separate act, per action, by an administrator. What these cases are about is
 * the join between the two: an arming is only ever a decision about the
 * declaration it was read against, so the write has to refuse once that
 * declaration is no longer the one on the row.
 */

const ROW = {
  id: "occupancy",
  packageName: "openbrf-plugin-occupancy",
  version: "1.0.0",
  tarballUrl: "https://example.test/occupancy.tgz",
  checksum: "sha512-x",
  enabled: true,
  status: "READY",
  lastError: null,
  consentedPermissions: ["addressBook:read"],
  declaredPersonalData: ["name"],
  consentedActions: ["summary:self:manage:name:mcp"],
  armedActions: [] as string[],
  settings: null,
  installedAt: new Date("2026-09-01T10:00:00.000Z"),
};

function build(overrides: Partial<typeof ROW> = {}) {
  const held = { ...ROW, ...overrides };
  const installedPlugin = {
    findUnique: vi.fn(async () => held),
    findUniqueOrThrow: vi.fn(async () => held),
    updateMany: vi.fn(async () => ({ count: 1 })),
  };
  const prisma = { installedPlugin };
  return {
    service: new PluginRegistryService(prisma as unknown as PrismaService),
    installedPlugin,
  };
}

describe("switching one of a plugin's actions on", () => {
  it("writes the id the board consented to", async () => {
    const { service, installedPlugin } = build();

    const record = await service.setActionArmed("occupancy", "summary", true);

    expect(record).not.toBeNull();
    expect(installedPlugin.updateMany).toHaveBeenCalledWith({
      where: {
        id: "occupancy",
        consentedActions: { equals: ROW.consentedActions },
        armedActions: { equals: [] },
      },
      data: { armedActions: ["summary"] },
    });
  });

  it("refuses an id outside the consented declaration", async () => {
    // The subset rule: arming is a decision about something the board agreed
    // to, so an id it never saw is not armable even by an administrator.
    const { service, installedPlugin } = build();

    expect(await service.setActionArmed("occupancy", "invented", true)).toBe(
      null,
    );
    expect(installedPlugin.updateMany).not.toHaveBeenCalled();
  });

  it("refuses once the consent it was decided against has moved", async () => {
    /*
     * The race this closes. A reinstall landing between the read and the write
     * consents to a republished declaration and clears the arming, exactly
     * because an action whose capability changed is a different action wearing
     * the same id. A write by id alone would put the id back after that reset,
     * and the new action would be live at its new capability with nobody having
     * decided so. Nought rows matched is that reinstall, and it is a refusal.
     */
    const { service, installedPlugin } = build();
    installedPlugin.updateMany.mockResolvedValue({ count: 0 });

    expect(await service.setActionArmed("occupancy", "summary", true)).toBe(
      null,
    );
    expect(installedPlugin.findUniqueOrThrow).not.toHaveBeenCalled();
  });

  it("takes an id back off the armed list", async () => {
    const { service, installedPlugin } = build({ armedActions: ["summary"] });

    await service.setActionArmed("occupancy", "summary", false);

    expect(installedPlugin.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { armedActions: [] } }),
    );
  });

  it("reads and writes through the caller's transaction", async () => {
    // So the entry naming who armed it commits with the arming itself.
    const { service } = build();
    const tx = {
      installedPlugin: {
        findUnique: vi.fn(async () => ROW),
        findUniqueOrThrow: vi.fn(async () => ROW),
        updateMany: vi.fn(async () => ({ count: 1 })),
      },
    };

    await service.setActionArmed(
      "occupancy",
      "summary",
      true,
      tx as unknown as Parameters<typeof service.setActionArmed>[3],
    );

    expect(tx.installedPlugin.updateMany).toHaveBeenCalledTimes(1);
  });
});

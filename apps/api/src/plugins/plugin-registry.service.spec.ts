import { describe, expect, it, vi } from "vitest";

import type { PrismaService } from "../database/prisma.service";
import { Prisma } from "../generated/prisma/client";
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
  lastError: null as string | null,
  lastErrorReason: null as string | null,
  lastErrorDetail: null as unknown,
  consentedPermissions: ["addressBook:read"],
  declaredPersonalData: ["name"],
  consentedActions: ["summary:self:manage:name:mcp"],
  armedActions: [] as string[],
  settings: null,
  installedAt: new Date("2026-09-01T10:00:00.000Z"),
};

/** Half of a surrogate pair; with the `u` flag a whole pair is one character. */
const UNPAIRED_SURROGATE = /\p{Cs}/u;

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

/** The failure columns the one `updateMany` call wrote. */
function failureWritten(
  installedPlugin: ReturnType<typeof build>["installedPlugin"],
) {
  const [[{ data }]] = installedPlugin.updateMany.mock.calls as unknown as [
    [{ data: { lastError: string; lastErrorDetail: Record<string, string> } }],
  ];
  return data;
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

/**
 * Why an install failed, as the row holds it.
 *
 * Three columns rather than one: a code and its values for the board, and the
 * English that was thrown for the operator. A row written before the code
 * existed has only the last, and has to keep reading as it always did.
 */
describe("a failed install", () => {
  it("writes the code, its values and what was thrown", async () => {
    const { service, installedPlugin } = build();

    await service.markFailed("occupancy", {
      reason: "source-answered-error",
      detail: { status: 404 },
      cause:
        "ResourceFetchError: https://example.test/occupancy.tgz answered 404.",
    });

    expect(installedPlugin.updateMany).toHaveBeenCalledWith({
      where: { id: "occupancy" },
      data: {
        status: "FAILED",
        lastError:
          "ResourceFetchError: https://example.test/occupancy.tgz answered 404.",
        lastErrorReason: "source-answered-error",
        lastErrorDetail: { status: 404 },
      },
    });
  });

  it("cuts a detail value an archive made too long", async () => {
    const { service, installedPlugin } = build();

    await service.markFailed("occupancy", {
      reason: "archive-package-mismatch",
      detail: {
        packageName: "@acme/occupancy",
        heldName: "x".repeat(10_000),
        heldVersion: "1.0.0",
      },
      cause: "PluginInstallError: The archive for @acme/occupancy@1.0.0 ...",
    });

    expect(installedPlugin.updateMany).toHaveBeenCalledWith({
      where: { id: "occupancy" },
      data: expect.objectContaining({
        lastErrorDetail: {
          packageName: "@acme/occupancy",
          heldName: `${"x".repeat(213)}…`,
          heldVersion: "1.0.0",
        },
      }),
    });
  });

  it("does not cut a value through the middle of a character", async () => {
    // The emoji is a surrogate pair across the cut. Half of it would be
    // written as `\ud83d`, which Postgres refuses in a JSON column, and the
    // failure would never be recorded.
    const { service, installedPlugin } = build();

    await service.markFailed("occupancy", {
      reason: "archive-package-mismatch",
      detail: {
        packageName: "@acme/occupancy",
        heldName: `${"x".repeat(212)}😀${"x".repeat(100)}`,
        heldVersion: "1.0.0",
      },
      cause: `PluginInstallError: ${"x".repeat(1979)}😀 ...`,
    });

    const data = failureWritten(installedPlugin);
    expect(data.lastErrorDetail.heldName).toBe(`${"x".repeat(212)}…`);
    expect(data.lastErrorDetail.heldName).not.toMatch(UNPAIRED_SURROGATE);
    expect(data.lastError).toHaveLength(1999);
    expect(data.lastError).not.toMatch(UNPAIRED_SURROGATE);
  });

  it("keeps a character whole that ends right at the cut", async () => {
    const { service, installedPlugin } = build();

    await service.markFailed("occupancy", {
      reason: "archive-package-mismatch",
      detail: { heldName: `${"x".repeat(211)}😀${"x".repeat(100)}` },
      cause: "PluginInstallError: ...",
    });

    const data = failureWritten(installedPlugin);
    expect(data.lastErrorDetail.heldName).toBe(`${"x".repeat(211)}😀…`);
  });

  it("clears all three once the install converges", async () => {
    const { service, installedPlugin } = build();

    await service.markInstalled("occupancy");

    expect(installedPlugin.updateMany).toHaveBeenCalledWith({
      where: { id: "occupancy" },
      data: {
        status: "INSTALLED",
        lastError: null,
        lastErrorReason: null,
        lastErrorDetail: Prisma.DbNull,
      },
    });
  });

  it("reads the code and its values back", async () => {
    const { service } = build({
      lastError: "ResourceFetchError: ... answered 404.",
      lastErrorReason: "source-answered-error",
      lastErrorDetail: { status: 404 },
    });

    const record = await service.find("occupancy");

    expect(record?.failure).toEqual({
      reason: "source-answered-error",
      detail: { status: 404 },
    });
    expect(record?.lastError).toBe("ResourceFetchError: ... answered 404.");
  });

  it("reads a row from before codes as its text alone", async () => {
    const { service } = build({
      lastError: "Error: Digest mismatch: the catalog declares ...",
    });

    const record = await service.find("occupancy");

    expect(record?.failure).toBeNull();
    expect(record?.lastError).toBe(
      "Error: Digest mismatch: the catalog declares ...",
    );
  });

  it("drops a stored value no sentence can be completed with", async () => {
    // The column is JSON. An object handed to a translation would read as
    // "[object Object]" in the middle of the board's sentence.
    const { service } = build({
      lastErrorReason: "archive-too-large",
      lastErrorDetail: { maxBytes: 67_108_864, nested: { no: true } },
    });

    const record = await service.find("occupancy");

    expect(record?.failure?.detail).toEqual({ maxBytes: 67_108_864 });
  });
});

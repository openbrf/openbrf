import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { INestApplicationContext } from "@nestjs/common";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { InstanceIdentityService } from "../licences/instance-identity.service";
import {
  LicenceAdminService,
  type LicenceView,
  type LicencesOverview,
} from "../licences/licence-admin.service";
import { runLicence } from "./licence-command";

const NEW = {
  instanceId: "4f1d2a9e-7c3b-4b6e-8f0a-1d2c3b4a5e6f",
  instanceKey: "a".repeat(43),
};

/** The command over an identity whose replacement is recorded. */
function application(licences: Partial<LicenceAdminService> = {}) {
  const replaceKey = vi.fn(async () => NEW);
  const services = new Map<unknown, unknown>([
    [LicenceAdminService, licences],
    [InstanceIdentityService, { replaceKey, binding: async () => NEW }],
  ]);
  return {
    replaceKey,
    context: {
      get: (token: unknown) => services.get(token),
    } as unknown as INestApplicationContext,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("openbrf licence replace-key", () => {
  it("replaces the key with the reason given, keeping the id", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const { context, replaceKey } = application();

    const code = await runLicence(
      context,
      ["replace-key", "a plugin since removed", "read the key"],
      new Set(),
      "usage",
    );

    expect(code).toBe(0);
    expect(replaceKey).toHaveBeenCalledWith({
      reason: "a plugin since removed read the key",
      newId: false,
    });
    expect(log.mock.calls.flat().join("\n")).toContain(
      `${NEW.instanceId} ${NEW.instanceKey}`,
    );
  });

  it("gives the instance a new id with --new-id", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const { context, replaceKey } = application();

    await runLicence(
      context,
      ["replace-key", "copied to staging"],
      new Set(["--new-id"]),
      "usage",
    );

    expect(replaceKey).toHaveBeenCalledWith({
      reason: "copied to staging",
      newId: true,
    });
  });

  it("refuses without a reason and replaces nothing", async () => {
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const { context, replaceKey } = application();

    const code = await runLicence(context, ["replace-key"], new Set(), "usage");

    expect(code).toBe(1);
    expect(replaceKey).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(expect.stringContaining("reason"));
  });
});

const OTHER = {
  instanceId: "9b7c3e2d-1a4f-4d8e-b6a5-0c1d2e3f4a5b",
  instanceKey: "b".repeat(43),
};

function viewFor(instance: typeof NEW): LicenceView {
  return {
    id: "licence-row-1",
    sha256: "c".repeat(64),
    keyId: "test-1",
    enteredAt: "2026-10-20T10:00:00.000Z",
    check: "verified",
    licenceId: "licence-1",
    verified: {
      issuedOn: "2026-10-01",
      ...instance,
      association: { name: "Brf Test", organizationNumber: null },
      entitlements: [
        { name: "mcp-connector", validUntil: null, updatesUntil: null },
      ],
      issuer: { name: "Test Issuer AB", url: "https://issuer.example" },
      pluginId: "mcp-connector",
    },
  };
}

function printed(log: { mock: { calls: unknown[][] } }): string[] {
  return log.mock.calls.map((call) => call.map(String).join(" "));
}

describe("openbrf licence list", () => {
  const overview: LicencesOverview = {
    instance: { ...NEW, keyReadable: true },
    licences: [viewFor(NEW)],
    plugins: [
      {
        pluginId: "mcp-connector",
        entitlement: "mcp-connector",
        issuer: { name: "Test Issuer AB", url: "https://issuer.example" },
        state: { status: "absent" },
      },
    ],
  };

  it("separates each plugin's reading line with a blank line, not a literal backslash-n", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const { context } = application({ overview: async () => overview });

    expect(await runLicence(context, ["list"], new Set(), "usage")).toBe(0);

    const lines = printed(log);
    const reading = lines.findIndex((line) => line.includes(" reads "));
    expect(lines[reading]).toMatch(/^mcp-connector {2}reads /);
    expect(lines[reading - 1]).toBe("");
    expect(lines.join("\n")).not.toContain("\\n");
  });

  it("marks a licence issued to another instance in its first line", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const { context } = application({
      overview: async () => ({
        ...overview,
        licences: [viewFor(NEW), { ...viewFor(OTHER), id: "licence-row-2" }],
      }),
    });

    await runLicence(context, ["list"], new Set(), "usage");

    const lines = printed(log);
    expect(lines).toContainEqual(
      expect.stringContaining("licence-row-1  [verified]  key"),
    );
    expect(lines).toContainEqual(
      expect.stringContaining(
        "licence-row-2  [verified, issued to another instance]  key",
      ),
    );
  });
});

describe("openbrf licence add", () => {
  let directory: string;

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  async function add(instance: typeof NEW): Promise<string[]> {
    directory = await mkdtemp(join(tmpdir(), "openbrf-licence-add-"));
    const file = join(directory, "licence.json");
    await writeFile(file, "{}");
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const { context } = application({ enter: async () => viewFor(instance) });

    expect(await runLicence(context, ["add", file], new Set(), "usage")).toBe(
      0,
    );
    return printed(log);
  }

  it("shows [verified] for a licence issued to this instance", async () => {
    expect(await add(NEW)).toContainEqual(
      expect.stringContaining("[verified]  key"),
    );
  });

  it("shows that a verified licence was issued to another instance", async () => {
    expect(await add(OTHER)).toContainEqual(
      expect.stringContaining("[verified, issued to another instance]  key"),
    );
  });
});

import type { INestApplicationContext } from "@nestjs/common";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { InstanceIdentityService } from "../licences/instance-identity.service";
import { LicenceAdminService } from "../licences/licence-admin.service";
import { runLicence } from "./licence-command";

const NEW = {
  instanceId: "4f1d2a9e-7c3b-4b6e-8f0a-1d2c3b4a5e6f",
  instanceKey: "a".repeat(43),
};

/** The command over an identity whose replacement is recorded. */
function application() {
  const replaceKey = vi.fn(async () => NEW);
  const services = new Map<unknown, unknown>([
    [LicenceAdminService, {}],
    [InstanceIdentityService, { replaceKey }],
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

import { Logger } from "@nestjs/common";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { LicenceAdminService } from "./licence-admin.service";

/**
 * Starting the core when the check of pending licences fails (ADR 0042: a
 * licence is never a reason for the core to refuse to start).
 */

function serviceWith(
  findMany: () => Promise<never>,
  binding: () => Promise<unknown>,
): LicenceAdminService {
  return new LicenceAdminService(
    { licence: { findMany } } as never,
    {} as never,
    { binding } as never,
    {} as never,
    { installedManifests: () => [] } as never,
    {} as never,
  );
}

describe("LicenceAdminService at start", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("starts, and logs only the error's name, when the pending check fails", async () => {
    const error = vi
      .spyOn(Logger.prototype, "error")
      .mockImplementation(() => undefined);
    const failure = Object.assign(new Error("secret detail"), {
      name: "PrismaClientKnownRequestError",
    });
    const service = serviceWith(
      () => Promise.reject(failure),
      () => Promise.resolve({}),
    );

    await expect(service.onApplicationBootstrap()).resolves.toBeUndefined();

    expect(error).toHaveBeenCalledOnce();
    expect(String(error.mock.calls[0]?.[0])).toContain(
      "PrismaClientKnownRequestError",
    );
    expect(String(error.mock.calls[0]?.[0])).not.toContain("secret detail");
  });

  it("still fails to start when the instance's identity cannot be read", async () => {
    const service = serviceWith(
      () => Promise.reject(new Error("unused")),
      () => Promise.reject(new Error("no identity")),
    );

    await expect(service.onApplicationBootstrap()).rejects.toThrow(
      "no identity",
    );
  });
});

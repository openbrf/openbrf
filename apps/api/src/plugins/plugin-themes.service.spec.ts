import { describe, expect, it, vi } from "vite-plus/test";

import { ActionCallerFactory } from "../actions/action-caller";
import { markAuthenticated } from "../actions/authenticated-request";
import type { Capability } from "../authorization/capabilities";
import type { PrincipalService } from "../authorization/principal.service";
import {
  ThemeInstallError,
  type ThemeInstallService,
} from "../themes/theme-install.service";
import { PluginThemesService } from "./plugin-themes.service";

/**
 * Who a plugin's theme install is made as.
 *
 * The person behind the request the plugin's route received, read from the
 * mark core put on it, holding association:manage at the moment of the call.
 * Anything else is refused before the installer sees the package.
 */

const ARCHIVE = new Uint8Array([1, 2, 3]);

/** A plugin without an AI package, as its manifest declares it. */
const PLUGIN = { ai: false };

/** A request as the guard leaves it: marked, with a principal on it. */
function request(options: { token?: boolean } = {}): object {
  const marked = {
    id: "req-1",
    principal: { personId: "person-1" },
  };
  markAuthenticated(marked, {
    personId: "person-1",
    token:
      options.token === true
        ? { clientId: "client-1", clientHost: null, scopes: [] }
        : null,
    requestId: "req-1",
  });
  return marked;
}

function harness(capabilities: readonly Capability[] | null) {
  const installFromPlugin = vi.fn(async () => ({
    theme: { id: "skogsglanta", version: "1.2.0" },
    warnings: [
      {
        rule: "unknown-token",
        severity: "warning",
        detail: { token: "future-token" },
      },
    ],
  }));
  const installedByPlugin = vi.fn(async () => []);
  const forPerson = vi.fn(async (personId: string) =>
    capabilities === null
      ? null
      : { personId, capabilities: new Set(capabilities) },
  );
  const service = new PluginThemesService(
    { installFromPlugin, installedByPlugin } as unknown as ThemeInstallService,
    new ActionCallerFactory(),
    { forPerson } as unknown as PrincipalService,
  );
  return { service, installFromPlugin, installedByPlugin, forPerson };
}

async function refusal(promise: Promise<unknown>): Promise<ThemeInstallError> {
  try {
    await promise;
  } catch (cause) {
    expect(cause).toBeInstanceOf(ThemeInstallError);
    return cause as ThemeInstallError;
  }
  throw new Error("Expected the install to be refused.");
}

describe("a plugin installing a theme", () => {
  it("installs as the person behind the request, who may manage the instance", async () => {
    const { service, installFromPlugin } = harness(["association:manage"]);

    const result = await service.install(
      "premium-themes",
      PLUGIN,
      request(),
      ARCHIVE,
      "sha512-abc",
    );

    expect(installFromPlugin).toHaveBeenCalledWith(
      "premium-themes",
      ARCHIVE,
      "sha512-abc",
      "person-1",
    );
    // The SDK's shape: the warnings without a severity, which is always
    // "warning" here, and the install's own summary left behind.
    expect(result).toEqual({
      id: "skogsglanta",
      version: "1.2.0",
      warnings: [{ rule: "unknown-token", detail: { token: "future-token" } }],
    });
  });

  it("refuses a person who may not install themes, before the installer runs", async () => {
    // A board seat reads the instance's settings; installing needs manage.
    const { service, installFromPlugin } = harness(["association:read"]);

    const failure = await refusal(
      service.install(
        "premium-themes",
        PLUGIN,
        request(),
        ARCHIVE,
        "sha512-abc",
      ),
    );

    expect(failure.reason).toBe("forbidden-capability");
    expect(failure.status).toBe(403);
    expect(installFromPlugin).not.toHaveBeenCalled();
  });

  it("refuses a person who no longer holds an account", async () => {
    const { service, installFromPlugin } = harness(null);

    const failure = await refusal(
      service.install(
        "premium-themes",
        PLUGIN,
        request(),
        ARCHIVE,
        "sha512-abc",
      ),
    );

    expect(failure.reason).toBe("forbidden-capability");
    expect(installFromPlugin).not.toHaveBeenCalled();
  });

  /*
   * Installing packages is kept out of reach of connected apps and the AI
   * package, so a token on the plugin's route does not reopen it, whatever
   * the person who connected the app may do in the web interface.
   */
  it("refuses a request a connected app's token reached", async () => {
    const { service, installFromPlugin, forPerson } = harness([
      "association:manage",
    ]);

    const failure = await refusal(
      service.install(
        "premium-themes",
        PLUGIN,
        request({ token: true }),
        ARCHIVE,
        "sha512-abc",
      ),
    );

    expect(failure.reason).toBe("forbidden-capability");
    expect(forPerson).not.toHaveBeenCalled();
    expect(installFromPlugin).not.toHaveBeenCalled();
  });

  it("refuses a request the AI package's plugin serves, even from a person's cookie", async () => {
    const { service, installFromPlugin } = harness(["association:manage"]);

    const failure = await refusal(
      service.install(
        "premium-themes",
        { ai: true },
        request(),
        ARCHIVE,
        "sha512-abc",
      ),
    );

    expect(failure.reason).toBe("forbidden-capability");
    expect(installFromPlugin).not.toHaveBeenCalled();
  });

  it("refuses an object core did not authenticate, whoever it names", async () => {
    const { service, installFromPlugin } = harness(["association:manage"]);

    await expect(
      service.install(
        "premium-themes",
        PLUGIN,
        { id: "forged", principal: { personId: "person-1" } },
        ARCHIVE,
        "sha512-abc",
      ),
    ).rejects.toThrow("not a request the platform authenticated");
    expect(installFromPlugin).not.toHaveBeenCalled();
  });

  it("lists only the calling plugin's own themes", async () => {
    const { service, installedByPlugin } = harness(["association:manage"]);

    await service.list("premium-themes");

    expect(installedByPlugin).toHaveBeenCalledWith("premium-themes");
  });
});

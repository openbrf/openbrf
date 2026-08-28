import type {
  PluginPermission,
  PluginPersonalDataCategory,
} from "@openbrf/plugin-sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Env } from "../config/env";
import type { CatalogPluginEntry } from "../packaging/catalog-entry";
import { PluginAdminService } from "./plugin-admin.service";
import { PluginConsentMismatchError } from "./plugin.errors";

/**
 * The consent gate in front of an install.
 *
 * The consent screen and the confirmation are two requests, and the catalog is
 * a file somebody can commit to in between - so the screen echoes back what it
 * showed, and the install is refused when that no longer matches. What makes
 * this a legal control rather than a validation nicety is what happens next:
 * the confirmed declaration is written to the row, and that row is the
 * snapshot the loader enforces against the installed manifest at every later
 * boot. A gate that can be walked past, or a row recording something wider
 * than what was displayed, means the record is not evidence of any consent the
 * board actually gave.
 */

const ENTRY = {
  type: "plugin",
  id: "occupancy",
  packageName: "openbrf-plugin-occupancy",
  version: "1.0.0",
  name: { sv: "Belaggning", en: "Occupancy" },
  description: { sv: "Testtillagg", en: "Test plugin" },
  deprecated: false,
  apiVersion: 1,
  permissions: ["addressBook:read", "mail:send"],
  personalData: ["name", "apartment"],
  artifact: { url: "https://example.test/occupancy.tgz", sha512: "sha512-x" },
} as unknown as CatalogPluginEntry;

function build() {
  const consent = vi.fn(async () => undefined);
  const service = new PluginAdminService(
    { OPENBRF_PLUGINS_ENABLED: true } as unknown as Env,
    { consent } as never,
    {
      report: () => [],
      get: () => null,
      manifestFor: () => undefined,
    } as never,
    { enqueue: vi.fn(async () => undefined) } as never,
    { entry: async () => ENTRY } as never,
    { record: vi.fn(async () => undefined) } as never,
    {} as never,
  );
  return { service, consent };
}

let service: PluginAdminService;
let consent: ReturnType<typeof vi.fn>;

beforeEach(() => {
  ({ service, consent } = build());
});

/** The declaration the row ended up asserting. */
function recorded(): {
  permissions: readonly string[];
  personalData: readonly string[];
} {
  return consent.mock.calls[0]?.[0] as {
    permissions: readonly string[];
    personalData: readonly string[];
  };
}

describe("the consent echo gate", () => {
  it("installs when the echo matches the catalog", async () => {
    await service.install(
      {
        id: "occupancy",
        permissions: ["mail:send", "addressBook:read"],
        personalData: ["apartment", "name"],
      },
      null,
    );

    // Order is not a gate: the catalog is free to list a declaration in any
    // order, and the screen renders it in whatever order it received.
    expect(consent).toHaveBeenCalledOnce();
    expect([...recorded().permissions].sort()).toEqual([
      "addressBook:read",
      "mail:send",
    ]);
  });

  it("refuses an echo that repeats one value in place of another", async () => {
    // Set comparison accepts this: the lengths match and every echoed value is
    // a member of the catalog's set. The board confirmed one permission and
    // the catalog declares two, so it is not the same declaration.
    await expect(
      service.install(
        {
          id: "occupancy",
          permissions: ["addressBook:read", "addressBook:read"],
          personalData: ["name", "apartment"],
        },
        null,
      ),
    ).rejects.toBeInstanceOf(PluginConsentMismatchError);
    expect(consent).not.toHaveBeenCalled();
  });

  it("refuses an echo that repeats one personal-data category for another", async () => {
    await expect(
      service.install(
        {
          id: "occupancy",
          permissions: ["addressBook:read", "mail:send"],
          personalData: ["name", "name"],
        },
        null,
      ),
    ).rejects.toBeInstanceOf(PluginConsentMismatchError);
    expect(consent).not.toHaveBeenCalled();
  });

  it("refuses a request that echoes the permissions and omits the personal data", async () => {
    // Omitting one field must not mean that field goes unchecked. The install
    // would otherwise proceed on a personal-data declaration nobody confirmed.
    await expect(
      service.install(
        { id: "occupancy", permissions: ["addressBook:read", "mail:send"] },
        null,
      ),
    ).rejects.toBeInstanceOf(PluginConsentMismatchError);
    expect(consent).not.toHaveBeenCalled();
  });

  it("refuses a request that echoes the personal data and omits the permissions", async () => {
    await expect(
      service.install(
        { id: "occupancy", personalData: ["name", "apartment"] },
        null,
      ),
    ).rejects.toBeInstanceOf(PluginConsentMismatchError);
    expect(consent).not.toHaveBeenCalled();
  });

  it("refuses an echo narrower than the catalog", async () => {
    await expect(
      service.install(
        {
          id: "occupancy",
          permissions: ["addressBook:read"],
          personalData: ["name", "apartment"],
        },
        null,
      ),
    ).rejects.toBeInstanceOf(PluginConsentMismatchError);
    expect(consent).not.toHaveBeenCalled();
  });

  it("records the confirmed declaration rather than the catalog's", async () => {
    /*
     * The two hold the same values once the gate above has passed, so what is
     * asserted is which array was written: the confirmed one is echoed in a
     * different order from the catalog's, and the order it was stored in says
     * which one the row came from. The row is what the loader enforces against
     * the installed manifest at every later boot, so it has to be the
     * declaration that was displayed and agreed to rather than a second copy
     * read from the source the gate exists to distrust.
     */
    const confirmed: PluginPermission[] = ["mail:send", "addressBook:read"];
    const confirmedData: PluginPersonalDataCategory[] = ["apartment", "name"];
    expect(confirmed).not.toEqual(ENTRY.permissions);

    await service.install(
      { id: "occupancy", permissions: confirmed, personalData: confirmedData },
      null,
    );

    expect(recorded().permissions).toEqual(confirmed);
    expect(recorded().personalData).toEqual(confirmedData);
  });

  it("records the catalog's declaration when nothing was echoed", async () => {
    // The command-line tool: running the command is the consent, there is no
    // earlier screen for the catalog to have changed since, and the tool
    // prints the entry's declaration before it acts.
    await service.install({ id: "occupancy" }, null);

    expect(recorded().permissions).toEqual(ENTRY.permissions);
    expect(recorded().personalData).toEqual(ENTRY.personalData);
  });
});

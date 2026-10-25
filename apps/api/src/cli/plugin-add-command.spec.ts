import type { PluginProcessing } from "@openbrf/plugin-sdk";
import { afterEach, beforeAll, describe, expect, it, vi } from "vite-plus/test";

import { I18nService } from "../i18n/i18n.service";
import type {
  CatalogPluginView,
  PluginAdminService,
} from "../plugins/plugin-admin.service";
import type { PluginInstallerService } from "../plugins/plugin-installer.service";
import { personalDataLabelKey } from "../plugins/plugin-labels";
import { addPlugin } from "./plugin-add-command";

/**
 * `openbrf plugin add`: what the operator reads before the install is what the
 * install echoes back, and nothing is written before it has been printed.
 */

const i18n = new I18nService();

beforeAll(async () => {
  await i18n.init();
});

afterEach(() => {
  vi.restoreAllMocks();
});

const PROCESSING: PluginProcessing = {
  purpose: { sv: "Visa namn i trapphuset", en: "Show names in the stairwell" },
  legalBasis: "legitimateInterest",
  legitimateInterest: {
    sv: "Att hitta rätt dörr",
    en: "Finding the right door",
  },
  retention: { sv: "Tills personen flyttar", en: "Until the person moves out" },
  dataSubjects: ["residents"],
};

function catalogEntry(
  overrides: Partial<CatalogPluginView> = {},
): CatalogPluginView {
  return {
    id: "stairwell-board",
    packageName: "@example/stairwell-board",
    version: "1.2.0",
    name: { sv: "Trapphustavla", en: "Stairwell board" },
    description: { sv: "Namn i trapphuset", en: "Names in the stairwell" },
    homepage: null,
    deprecated: false,
    apiVersion: 1,
    personRecords: [],
    permissions: ["addressBook:read"],
    personalData: ["name", "apartment"],
    processing: PROCESSING,
    actions: [],
    oauthProtectedResource: null,
    recipients: [],
    deviceRoutes: [],
    extensionPoints: [],
    extends: [],
    holdsToBoard: [],
    ai: false,
    licence: null,
    released: null,
    releaseNotCovered: null,
    supported: true,
    installedVersion: null,
    recipientState: "notRecorded",
    ...overrides,
  };
}

/**
 * The command over a catalog of one entry. The install records how much had
 * been printed when it was called, so a test can tell what the operator had
 * read by then.
 */
function command(entry: CatalogPluginView) {
  const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  const printed = () => log.mock.calls.map((call) => String(call[0]));
  let printedBeforeInstall: string[] | null = null;
  const install = vi.fn(async () => {
    printedBeforeInstall = printed();
  });
  const admin = {
    browseCatalog: async () => ({ source: "test", entries: [entry] }),
    install,
  } as unknown as PluginAdminService;
  const installer = {
    reconcile: async () => ({ failed: [] }),
  } as unknown as PluginInstallerService;
  return {
    install,
    printed,
    printedBeforeInstall: () => printedBeforeInstall,
    run: (dryRun: boolean) =>
      addPlugin(admin, installer, i18n, entry.id, dryRun),
  };
}

const DECLARATION = [
  "  What the processing is for",
  "    Purpose: Show names in the stairwell",
  "    Legal basis: legitimate interest (art. 6(1)(f)). The interest: Finding the right door",
  "    Kept: Until the person moves out",
  "    Whose data: residents",
];

describe("openbrf plugin add", () => {
  it("prints the processing it echoes before installing", async () => {
    const { install, printedBeforeInstall, run } = command(catalogEntry());

    expect(await run(false)).toBe(0);

    expect(install).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "stairwell-board",
        processing: PROCESSING,
      }),
      null,
      "SYSTEM",
    );
    expect(printedBeforeInstall()).toEqual(expect.arrayContaining(DECLARATION));
  });

  it("prints the processing on a dry run and installs nothing", async () => {
    const { install, printed, run } = command(catalogEntry());

    expect(await run(true)).toBe(0);

    expect(install).not.toHaveBeenCalled();
    expect(printed()).toEqual(expect.arrayContaining(DECLARATION));
  });

  it("says a plugin declares no processing, and echoes that it declared none", async () => {
    const { install, printedBeforeInstall, run } = command(
      catalogEntry({ processing: null }),
    );

    expect(await run(false)).toBe(0);

    expect(install).toHaveBeenCalledWith(
      expect.objectContaining({ processing: null }),
      null,
      "SYSTEM",
    );
    expect(printedBeforeInstall()).toEqual(
      expect.arrayContaining([
        "  What the processing is for",
        `    ${i18n.translatorFor("en")("plugins.consent.processing.undeclared")}`,
      ]),
    );
  });

  it("prints what it keeps about a person before it installs, and echoes it", async () => {
    // ADR 0047: each collection with its categories and its bound, then that
    // the host erases and reports them.
    const claims = {
      collection: "claims",
      titleKey: "records.claims.title",
      personalData: ["apartment" as const],
      keepAtMostDays: 730,
      fields: [],
    };
    const { install, printedBeforeInstall, run } = command(
      catalogEntry({
        personalData: ["name", "apartment"],
        personRecords: [claims],
      }),
    );

    expect(await run(false)).toBe(0);

    const t = i18n.translatorFor("en");
    expect(printedBeforeInstall()).toEqual(
      expect.arrayContaining([
        `  ${t("plugins.consent.personRecords.title")}`,
        `    ${t("plugins.consent.personRecords.collection", {
          collection: "claims",
          categories: t(personalDataLabelKey("apartment")),
          days: 730,
        })}`,
        `    ${t("plugins.consent.personRecords.host")}`,
      ]),
    );
    expect(install).toHaveBeenCalledWith(
      expect.objectContaining({ personRecords: [claims] }),
      null,
      "SYSTEM",
    );
  });

  it("prints no processing for a plugin that handles nobody's data", async () => {
    const { printed, run } = command(
      catalogEntry({ personalData: [], processing: null }),
    );

    expect(await run(true)).toBe(0);

    expect(printed()).not.toContain("  What the processing is for");
  });
});

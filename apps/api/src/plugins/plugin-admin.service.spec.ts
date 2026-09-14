import type {
  PluginPermission,
  PluginPersonalDataCategory,
} from "@openbrf/plugin-sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Env } from "../config/env";
import type { CatalogPluginEntry } from "../packaging/catalog-entry";
import { PluginAdminService } from "./plugin-admin.service";
import {
  PluginConsentMismatchError,
  PluginNotFoundError,
  PluginRecipientRequiredError,
} from "./plugin.errors";

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
  actions: [],
  artifact: { url: "https://example.test/occupancy.tgz", sha512: "sha512-x" },
} as unknown as CatalogPluginEntry;

function build() {
  const consent = vi.fn(async () => undefined);
  const recordProcessor = vi.fn(async () => undefined);
  const setActionArmed = vi.fn(async () => ({ id: "occupancy" }));
  const record = vi.fn(async () => undefined);
  /*
   * The transaction client, as its own object. Arming and the entry that
   * records it have to commit together, and an assertion that the entry was
   * written with "something" cannot tell that apart from the root client.
   */
  const txClient = { marker: "tx" };
  const prisma = {
    association: { findUnique: async () => ({ defaultLocale: "sv" }) },
    $transaction: vi.fn(
      async (run: unknown) =>
        await (run as (tx: unknown) => Promise<unknown>)(txClient),
    ),
  };
  const service = new PluginAdminService(
    { OPENBRF_PLUGINS_ENABLED: true } as unknown as Env,
    { consent, setActionArmed } as never,
    {
      report: () => [],
      get: () => null,
      manifestFor: () => undefined,
    } as never,
    { enqueue: vi.fn(async () => undefined) } as never,
    { entry: async () => ENTRY } as never,
    { record } as never,
    {} as never,
    // The recipient's classification, the processing it performs, and what the
    // instance is configured to hand data to. Recorded on install; the
    // assertions here are about the consent row, so these only have to exist.
    { record: recordProcessor } as never,
    { seedPlugin: vi.fn(async () => undefined) } as never,
    { read: async () => FACTS } as never,
    // The association's language for the note the instance writes on a plugin
    // that hands nothing to anybody.
    prisma as never,
    { translatorFor: () => (key: string) => key } as never,
  );
  return {
    service,
    consent,
    recordProcessor,
    setActionArmed,
    record,
    prisma,
    txClient,
  };
}

/** What the instance hands personal data to; nothing here depends on it. */
const FACTS = {
  smtpHost: null,
  smtpFromAddress: null,
  smsDriver: null,
  smsGatewayUrl: null,
  storageDriver: "local" as const,
  s3Endpoint: null,
  s3Region: null,
  s3Bucket: null,
  installedPlugins: [],
};

let service: PluginAdminService;
let consent: ReturnType<typeof vi.fn>;
let recordProcessor: ReturnType<typeof vi.fn>;

beforeEach(() => {
  ({ service, consent, recordProcessor } = build());
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
      "WEB",
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
        "WEB",
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
        "WEB",
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
        "WEB",
      ),
    ).rejects.toBeInstanceOf(PluginConsentMismatchError);
    expect(consent).not.toHaveBeenCalled();
  });

  it("refuses a request that echoes the personal data and omits the permissions", async () => {
    await expect(
      service.install(
        { id: "occupancy", personalData: ["name", "apartment"] },
        null,
        "WEB",
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
        "WEB",
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
      "WEB",
    );

    expect(recorded().permissions).toEqual(confirmed);
    expect(recorded().personalData).toEqual(confirmedData);
  });

  it("records the catalog's declaration when nothing was echoed", async () => {
    // The command-line tool: running the command is the consent, there is no
    // earlier screen for the catalog to have changed since, and the tool
    // prints the entry's declaration before it acts.
    await service.install({ id: "occupancy" }, null, "SYSTEM");

    expect(recorded().permissions).toEqual(ENTRY.permissions);
    expect(recorded().personalData).toEqual(ENTRY.personalData);
  });
});

describe("what the consent step records about the recipient", () => {
  /** The classification the install wrote, if it wrote one. */
  function classified(): {
    classification: string;
    status?: string | null;
    channel: string;
  } {
    return recordProcessor.mock.calls[0]?.[1] as {
      classification: string;
      status?: string | null;
      channel: string;
    };
  }

  it("records no processor when the plugin sends nothing outside", async () => {
    /*
     * The ordinary case. A plugin runs inside the instance's own process, so
     * code that sends nothing anywhere receives nothing on the association's
     * behalf and GDPR art. 28(3) has no contract to require.
     */
    await service.install(
      {
        id: "occupancy",
        permissions: ["mail:send", "addressBook:read"],
        personalData: ["apartment", "name"],
        processorAgreement: { sendsPersonalDataOutside: false },
      },
      null,
      "WEB",
    );

    expect(classified().classification).toBe("NOT_A_PROCESSOR");
  });

  it("classifies the recipient through the channel the install came by", async () => {
    /*
     * The command-line install reaches the art. 28 record through the same
     * method the board screen does. Naming WEB where the row is written would
     * put a person in a browser behind a change no person made, which is the
     * one thing the channel exists to stop.
     */
    await service.install(
      {
        id: "occupancy",
        permissions: ["mail:send", "addressBook:read"],
        personalData: ["apartment", "name"],
        processorAgreement: { sendsPersonalDataOutside: false },
      },
      null,
      "SYSTEM",
    );

    expect(classified()).toMatchObject({ channel: "SYSTEM" });
  });

  it("refuses to record a recipient nobody named", async () => {
    /*
     * art. 30(1)(d) asks who receives the data. "Somewhere outside" is not an
     * answer a record can carry.
     *
     * The error class and not just "it threw": five different failures reach
     * this path, and a bare assertion would stay green if the recipient stopped
     * being required and something else refused the install instead. Nothing is
     * classified either, and nothing is consented: the answer is refused before
     * the first write, so a rejected install leaves no consent row behind
     * claiming an install that never happened.
     */
    await expect(
      service.install(
        {
          id: "occupancy",
          permissions: ["mail:send", "addressBook:read"],
          personalData: ["apartment", "name"],
          processorAgreement: { sendsPersonalDataOutside: true },
        },
        null,
        "WEB",
      ),
    ).rejects.toThrow(PluginRecipientRequiredError);

    expect(recordProcessor).not.toHaveBeenCalled();
    expect(consent).not.toHaveBeenCalled();
  });

  it("records a processor with the recipient the board named", async () => {
    await service.install(
      {
        id: "occupancy",
        permissions: ["mail:send", "addressBook:read"],
        personalData: ["apartment", "name"],
        processorAgreement: {
          sendsPersonalDataOutside: true,
          recipient: "Belaggningstjansten AB",
        },
      },
      null,
      "WEB",
    );

    expect(classified()).toMatchObject({
      classification: "PROCESSOR",
      // Being made, not in place: the board has not said an agreement exists.
      status: "PENDING",
      counterparty: "Belaggningstjansten AB",
    });
  });

  it("keeps the classification out of the declaration a reinstall compares", async () => {
    /*
     * The consent row asserts what the board was shown and agreed to. A
     * classification recorded beside it would make an answer about a mail
     * server look like a change to what the plugin asked for, and the next
     * reinstall would refuse on a mismatch nobody made.
     */
    await service.install(
      {
        id: "occupancy",
        permissions: ["mail:send", "addressBook:read"],
        personalData: ["apartment", "name"],
        processorAgreement: { sendsPersonalDataOutside: false },
      },
      null,
      "WEB",
    );

    expect(Object.keys(recorded())).not.toContain("processorAgreement");
  });
});

describe("arming an action, which is what exposes it", () => {
  it("writes the change and the entry naming who made it in one transaction", async () => {
    /*
     * Arming is the act that puts an action within reach of a connected app or
     * the AI package. If the change committed on its own and the entry then
     * failed, the action would be armed with nobody named for it - and
     * audit_log_entry is what the association answers with, not a log.
     */
    const built = build();

    await built.service.setActionArmed("occupancy", "summary", true, "admin-1");

    expect(built.prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(built.setActionArmed).toHaveBeenCalledWith(
      "occupancy",
      "summary",
      true,
      built.txClient,
    );
    expect(built.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "PLUGIN_ACTION_ARMED",
        actorPersonId: "admin-1",
        targetKind: "plugin",
        targetId: "occupancy",
        context: { actionId: "summary" },
      }),
      built.txClient,
    );
  });

  it("writes no entry where the arming was refused", async () => {
    // A refusal is a 404, and the transaction rolls back with it: there is no
    // change for an entry to record.
    const built = build();
    built.setActionArmed.mockResolvedValue(null as never);

    await expect(
      built.service.setActionArmed("occupancy", "summary", true, "admin-1"),
    ).rejects.toBeInstanceOf(PluginNotFoundError);

    expect(built.record).not.toHaveBeenCalled();
  });

  it("names the disarming for what it is", async () => {
    const built = build();

    await built.service.setActionArmed(
      "occupancy",
      "summary",
      false,
      "admin-1",
    );

    expect(built.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: "PLUGIN_ACTION_DISARMED" }),
      built.txClient,
    );
  });
});

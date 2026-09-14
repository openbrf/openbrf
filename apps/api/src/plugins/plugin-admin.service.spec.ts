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
  PluginReservedIdError,
  PluginResourceConflictError,
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

interface InstalledPluginFixture {
  id: string;
  manifest: { oauthProtectedResource?: string } | null;
}

interface Options {
  /** What the catalog answers with for the id being installed. */
  entry?: CatalogPluginEntry;
  installed?: readonly InstalledPluginFixture[];
  /** What the index lists, when the subject is browsing rather than installing. */
  listed?: readonly CatalogPluginEntry[];
}

function build(options: Options = {}) {
  const entry = options.entry ?? ENTRY;
  const installed = options.installed ?? [];
  const listed = options.listed ?? [entry];
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
    {
      consent,
      setActionArmed,
      list: async () => installed.map(({ id }) => ({ id })),
    } as never,
    {
      report: () => [],
      get: () => null,
      manifestFor: (id: string) =>
        installed.find((record) => record.id === id)?.manifest ?? null,
    } as never,
    { enqueue: vi.fn(async () => undefined) } as never,
    {
      entry: async () => entry,
      read: async () => ({ version: 1, entries: listed }),
      resolveUrl: () => "https://catalog.openbrf.test/index.json",
    } as never,
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

describe("the catalog entries the consent screen reads", () => {
  it("carries the connected-app sign-in route an entry declares", async () => {
    const { service } = build({
      listed: [{ ...ENTRY, oauthProtectedResource: "mcp" }],
    });

    const { entries } = await service.browseCatalog();

    expect(entries[0]?.oauthProtectedResource).toBe("mcp");
  });

  it("says none for an entry that serves no such route", async () => {
    // Null rather than absent: the browser echoes it back as the statement
    // that the screen showed no address, and that is what an entry acquiring
    // one after the screen was drawn is compared against.
    const { service } = build({ listed: [ENTRY] });

    const { entries } = await service.browseCatalog();

    expect(entries[0]?.oauthProtectedResource).toBeNull();
  });
});

describe("the gates on the OAuth protected resource", () => {
  const RESERVED = "mcp-connector";

  /** A catalog entry at `id`, serving the resource when one is given. */
  function entryFor(id: string, resource?: string): CatalogPluginEntry {
    return {
      ...ENTRY,
      id,
      ...(resource === undefined ? {} : { oauthProtectedResource: resource }),
    };
  }

  /** An installed connector, as the loader reports it. */
  const CONNECTOR: InstalledPluginFixture = {
    id: "connector-a",
    manifest: { oauthProtectedResource: "mcp" },
  };

  /**
   * Installs with no echo, which is the route the command-line tool takes: the
   * echo gate is the subject of the block above, and nothing here turns on it.
   *
   * The promise is returned rather than awaited so a refusal can be asserted on
   * it, and the consent mock beside it so a successful install can be asserted
   * to have written the row.
   */
  function installing(options: Options): {
    done: Promise<{ restarting: boolean }>;
    consent: ReturnType<typeof vi.fn>;
  } {
    const built = build(options);
    return {
      done: built.service.install(
        { id: (options.entry ?? ENTRY).id },
        null,
        "SYSTEM",
      ),
      consent: built.consent,
    };
  }

  it("refuses an echo that agrees on everything but names no resource", async () => {
    /*
     * The echo confirms the permissions, the personal data and the actions,
     * and says nothing about the resource - which is exactly what a screen
     * drawn before the entry came to declare one produces. Installing on it
     * would hand a plugin the address connected apps sign in to, on a consent
     * that never mentioned it.
     *
     * Not reachable through `installing()`, which sends no echo at all: with
     * `echoed` false the whole comparison is skipped, so the resource term
     * needs a request that turns the gate on.
     */
    const { service, consent } = build({
      entry: entryFor("connector-a", "mcp"),
    });

    await expect(
      service.install(
        {
          id: "connector-a",
          permissions: ["addressBook:read", "mail:send"],
          personalData: ["name", "apartment"],
          actions: [],
        },
        null,
        "WEB",
      ),
    ).rejects.toBeInstanceOf(PluginConsentMismatchError);
    expect(consent).not.toHaveBeenCalled();
  });

  it("accepts an echo that names the resource the entry declares", async () => {
    // The other direction, so the comparison cannot be satisfied by refusing
    // every echo that reaches it: a board that was shown the resource and
    // confirmed it installs.
    const { service, consent } = build({
      entry: entryFor("connector-a", "mcp"),
    });

    await service.install(
      {
        id: "connector-a",
        permissions: ["addressBook:read", "mail:send"],
        personalData: ["name", "apartment"],
        actions: [],
        oauthProtectedResource: "mcp",
      },
      null,
      "WEB",
    );

    expect(consent).toHaveBeenCalledOnce();
  });

  it("refuses a second plugin that declares the resource", async () => {
    const { done, consent } = installing({
      entry: entryFor("connector-b", "mcp"),
      installed: [CONNECTOR],
    });

    await expect(done).rejects.toBeInstanceOf(PluginResourceConflictError);
    // Refused before the first write, so nothing is left behind claiming a
    // consent that produced no install.
    expect(consent).not.toHaveBeenCalled();
  });

  it("lets the plugin that already holds the resource be installed again", async () => {
    /*
     * The case most easily got wrong, and the one that matters most. An upgrade
     * and a repeated install write the same row, so reading "this id is already
     * installed declaring a resource" as a conflict would leave a connector
     * nobody could ever patch: the only ways out would be to uninstall it
     * first, which strands every token issued in the meantime, or to edit the
     * row by hand.
     */
    const { done, consent } = installing({
      entry: entryFor(CONNECTOR.id, "mcp"),
      installed: [CONNECTOR],
    });

    await done;
    expect(consent).toHaveBeenCalledOnce();
  });

  it("refuses the reserved id to a plugin that does not serve the resource", async () => {
    /*
     * The error class rather than "it threw". The reserved id and the conflict
     * are different refusals with different answers - one says the id is not
     * this plugin's to take, the other says another connector has to go first -
     * and a board member reads one sentence or the other.
     */
    const { done, consent } = installing({ entry: entryFor(RESERVED) });

    await expect(done).rejects.toBeInstanceOf(PluginReservedIdError);
    expect(consent).not.toHaveBeenCalled();
  });

  it("allows the reserved id to a plugin that does serve the resource", async () => {
    // What the id is reserved for. An instance with no connector advertises
    // this mount as its resource already, and the plugin that takes the id is
    // the one making that advertisement true.
    const { done, consent } = installing({ entry: entryFor(RESERVED, "mcp") });

    await done;
    expect(consent).toHaveBeenCalledOnce();
  });

  it("leaves a plugin that declares no resource alone", async () => {
    // The ordinary install, alongside a connector that does hold the resource.
    // Only a declaration competes with a declaration; a plugin serving no MCP
    // route is not asking for the audience.
    const { done, consent } = installing({
      entry: ENTRY,
      installed: [CONNECTOR],
    });

    await done;
    expect(consent).toHaveBeenCalledOnce();
  });

  it("ignores an installed plugin whose manifest declares nothing", async () => {
    // An instance full of ordinary plugins is not an instance that has a
    // connector, and the row alone cannot tell the two apart - which is why the
    // manifest is what is read.
    const { done, consent } = installing({
      entry: entryFor("connector-a", "mcp"),
      installed: [
        { id: "occupancy", manifest: {} },
        { id: "grannsamverkan", manifest: null },
      ],
    });

    await done;
    expect(consent).toHaveBeenCalledOnce();
  });
});

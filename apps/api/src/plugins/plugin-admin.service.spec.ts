import type {
  PluginPermission,
  PluginPersonalDataCategory,
} from "@openbrf/plugin-sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Env } from "../config/env";
import { ProcessorAgreementError } from "../data-protection/processor-agreement.service";
import type { CatalogPluginEntry } from "../packaging/catalog-entry";
import { PluginAdminService } from "./plugin-admin.service";
import { PluginInstallerService } from "./plugin-installer.service";
import {
  PluginConsentMismatchError,
  PluginEntryDeprecatedError,
  PluginNotFoundError,
  PluginRecipientAlreadyRecordedError,
  PluginRecipientRequiredError,
  PluginReservedIdError,
  PluginResourceConflictError,
} from "./plugin.errors";
import { RestartCoordinator } from "./restart-coordinator.service";

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
  /** What its cached copy still says, until a read asks for a refresh. */
  cachedEntry?: CatalogPluginEntry;
  installed?: readonly InstalledPluginFixture[];
  /** What the index lists, when the subject is browsing rather than installing. */
  listed?: readonly CatalogPluginEntry[];
  /** What the record of recipients says, by plugin id. */
  recipients?: ReadonlyMap<string, string>;
  /** OPENBRF_PLUGINS_ENABLED; on unless the instance is the subject. */
  pluginsEnabled?: boolean;
}

function build(options: Options = {}) {
  const entry = options.entry ?? ENTRY;
  const installed = options.installed ?? [];
  const listed = options.listed ?? [entry];
  const env = {
    NODE_ENV: "test",
    OPENBRF_PLUGINS_ENABLED: options.pluginsEnabled ?? true,
  } as unknown as Env;
  /*
   * The coordinator and the enqueue are the real ones, over a queue that only
   * records: what the overview says between an operation being accepted and
   * its reconcile running is decided in those two, and no worker consumes the
   * queue here, so every overview below is read inside that window.
   */
  const restart = new RestartCoordinator(env);
  const installer = new PluginInstallerService(
    env,
    {} as never,
    { send: vi.fn(async () => "job-1") } as never,
    {} as never,
    restart,
    {} as never,
  );
  const consent = vi.fn(async () => undefined);
  const recordProcessor = vi.fn(async () => undefined);
  const seedPlugin = vi.fn(async () => undefined);
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
    env,
    {
      consent,
      setActionArmed,
      list: async () => installed.map(({ id }) => ({ id })),
      find: async (id: string) =>
        installed.some((record) => record.id === id) ? { id } : null,
      remove: async () => true,
    } as never,
    {
      report: () => [],
      get: () => null,
      manifestFor: (id: string) =>
        installed.find((record) => record.id === id)?.manifest ?? null,
    } as never,
    installer,
    {
      entry: async (_id: string, read?: { refresh?: boolean }) =>
        read?.refresh === true ? entry : (options.cachedEntry ?? entry),
      read: async () => ({ version: 1, entries: listed }),
      resolveUrl: () => "https://catalog.openbrf.test/index.json",
    } as never,
    { record } as never,
    restart,
    // The recipient's classification, the processing it performs, and what the
    // instance is configured to hand data to. Recorded on install; the
    // assertions here are about the consent row, so these only have to exist.
    {
      record: recordProcessor,
      forPlugins: async () => new Map(options.recipients ?? []),
    } as never,
    { seedPlugin, endPlugin: vi.fn(async () => undefined) } as never,
    { read: async () => FACTS } as never,
    // The association's language for the note the instance writes on a plugin
    // that hands nothing to anybody.
    prisma as never,
    { translatorFor: () => (key: string) => key } as never,
    // The lock has no meaning without a database; package-lock.int-spec.ts
    // tests it against one.
    {
      run: async (_kind: string, _id: string, work: () => unknown) => work(),
    } as never,
  );
  return {
    service,
    consent,
    recordProcessor,
    seedPlugin,
    setActionArmed,
    record,
    prisma,
    txClient,
    restart,
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

  it("refuses a version other than the one the operator was shown", async () => {
    // The declaration is unchanged, so only the version tells the release the
    // operator read about from the one the catalog now names.
    const refusal = service.install(
      {
        id: "occupancy",
        expectedVersion: "0.9.0",
        permissions: ["addressBook:read", "mail:send"],
        personalData: ["name", "apartment"],
      },
      null,
      "SYSTEM",
    );
    await expect(refusal).rejects.toBeInstanceOf(PluginConsentMismatchError);
    // A command-line operator never opened a screen, and only the release
    // changed: the message must say neither of the wrong things.
    await expect(refusal).rejects.toMatchObject({
      reason: "plugin-consent-mismatch",
      message: expect.stringMatching(/release/),
    });
    await expect(refusal).rejects.toMatchObject({
      message: expect.not.stringMatching(/screen/),
    });
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

  /*
   * The rest of what the art. 28 record refuses, asked before the consent row
   * like the recipient above. The command-line tool sends no recipient answer,
   * so these reach the API from a direct caller such as a script, and each used
   * to be refused only after the consent row was committed.
   */
  it.each([
    {
      case: "an independent controller with no reason given",
      answer: {
        sendsPersonalDataOutside: true,
        recipient: "Belaggningstjansten AB",
        classification: "INDEPENDENT_CONTROLLER" as const,
      },
      reason: "note-required",
    },
    {
      case: "a personal identity number as the recipient",
      answer: { sendsPersonalDataOutside: true, recipient: "811228-9874" },
      reason: "personal-identity-number",
    },
    {
      case: "a personal identity number in the note",
      answer: {
        sendsPersonalDataOutside: true,
        recipient: "Belaggningstjansten AB",
        note: "Kontakt 811228-9874",
      },
      reason: "personal-identity-number",
    },
    {
      case: "a personal identity number in the note of a plugin sending nothing",
      answer: { sendsPersonalDataOutside: false, note: "Kontakt 811228-9874" },
      reason: "personal-identity-number",
    },
    {
      case: "an agreement in place with no date",
      answer: {
        sendsPersonalDataOutside: true,
        recipient: "Belaggningstjansten AB",
        status: "IN_PLACE" as const,
        termsConfirmed: true,
      },
      reason: "signed-on-required",
    },
    {
      case: "an agreement in place without the art. 28(3) terms",
      answer: {
        sendsPersonalDataOutside: true,
        recipient: "Belaggningstjansten AB",
        status: "IN_PLACE" as const,
        signedOn: "2026-09-01",
      },
      reason: "terms-required",
    },
  ])(
    "refuses $case before any consent is written",
    async ({ answer, reason }) => {
      const refused = service.install(
        {
          id: "occupancy",
          permissions: ["mail:send", "addressBook:read"],
          personalData: ["apartment", "name"],
          processorAgreement: answer,
        },
        null,
        "SYSTEM",
      );

      await expect(refused).rejects.toBeInstanceOf(ProcessorAgreementError);
      await expect(refused).rejects.toMatchObject({ reason });

      expect(recordProcessor).not.toHaveBeenCalled();
      expect(consent).not.toHaveBeenCalled();
    },
  );

  it("leaves the record of recipients alone when the request carries no answer", async () => {
    // A reinstall over a classification the board has completed sends none.
    await service.install(
      {
        id: "occupancy",
        permissions: ["mail:send", "addressBook:read"],
        personalData: ["apartment", "name"],
      },
      null,
      "WEB",
    );

    expect(consent).toHaveBeenCalledTimes(1);
    expect(recordProcessor).not.toHaveBeenCalled();
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

  /*
   * A form sends an emptied field as an empty string, not as a missing key.
   * Read as an answer, it would win over the value it was meant to leave alone.
   */
  it("names the recipient as the other party when the other party was left empty", async () => {
    await service.install(
      {
        id: "occupancy",
        permissions: ["mail:send", "addressBook:read"],
        personalData: ["apartment", "name"],
        processorAgreement: {
          sendsPersonalDataOutside: true,
          recipient: "Belaggningstjansten AB",
          classification: "INDEPENDENT_CONTROLLER",
          counterparty: "  ",
          note: "Decides its own purposes for the occupancy data.",
        },
      },
      null,
      "WEB",
    );

    expect(classified()).toMatchObject({
      classification: "INDEPENDENT_CONTROLLER",
      counterparty: "Belaggningstjansten AB",
    });
  });

  it("gives the instance's own reason when a plugin sending nothing has an empty note", async () => {
    await service.install(
      {
        id: "occupancy",
        permissions: ["mail:send", "addressBook:read"],
        personalData: ["apartment", "name"],
        processorAgreement: { sendsPersonalDataOutside: false, note: "" },
      },
      null,
      "WEB",
    );

    // The translator in `build` answers with the key it was asked for.
    expect(classified()).toMatchObject({
      classification: "NOT_A_PROCESSOR",
      note: "dataProtection.processors.seed.pluginLocal",
    });
  });

  it("reads the other party as the recipient when the recipient was left empty", async () => {
    await service.install(
      {
        id: "occupancy",
        permissions: ["mail:send", "addressBook:read"],
        personalData: ["apartment", "name"],
        processorAgreement: {
          sendsPersonalDataOutside: true,
          recipient: "",
          counterparty: "Belaggningstjansten AB",
        },
      },
      null,
      "WEB",
    );

    expect(classified()).toMatchObject({
      classification: "PROCESSOR",
      counterparty: "Belaggningstjansten AB",
    });
  });

  it("records no agreement details for an independent controller", async () => {
    /*
     * The date an agreement was signed, its reference and its note on
     * sub-processors describe an art. 28(3) contract, and an independent
     * controller has none to describe.
     */
    await service.install(
      {
        id: "occupancy",
        permissions: ["mail:send", "addressBook:read"],
        personalData: ["apartment", "name"],
        processorAgreement: {
          sendsPersonalDataOutside: true,
          recipient: "Belaggningstjansten AB",
          classification: "INDEPENDENT_CONTROLLER",
          signedOn: "2026-09-01",
          reference: "Avtal 2026/14",
          subProcessorNote: "Hosts with Driftbolaget AB.",
          note: "Decides its own purposes for the occupancy data.",
        },
      },
      null,
      "WEB",
    );

    expect(classified()).toMatchObject({
      classification: "INDEPENDENT_CONTROLLER",
      signedOn: null,
      reference: null,
      subProcessorNote: null,
    });
  });

  it("keeps the agreement details for a processor", async () => {
    await service.install(
      {
        id: "occupancy",
        permissions: ["mail:send", "addressBook:read"],
        personalData: ["apartment", "name"],
        processorAgreement: {
          sendsPersonalDataOutside: true,
          recipient: "Belaggningstjansten AB",
          status: "IN_PLACE",
          termsConfirmed: true,
          signedOn: "2026-09-01",
          reference: "Avtal 2026/14",
        },
      },
      null,
      "WEB",
    );

    expect(classified()).toMatchObject({
      classification: "PROCESSOR",
      signedOn: new Date("2026-09-01"),
      reference: "Avtal 2026/14",
    });
  });

  it("records an independent controller with the reason and no agreement", async () => {
    /*
     * The other answer the consent step offers once the board says data leaves.
     * A controller in its own right has no art. 28(3) agreement, so every field
     * describing one has to arrive empty - the record refuses them on this
     * classification - and the reason the board gave is what the record keeps
     * instead of an agreement.
     */
    await service.install(
      {
        id: "occupancy",
        permissions: ["mail:send", "addressBook:read"],
        personalData: ["apartment", "name"],
        processorAgreement: {
          sendsPersonalDataOutside: true,
          recipient: "Kartbolaget AB",
          classification: "INDEPENDENT_CONTROLLER",
          note: "Bestammer sjalv over sina kartdata.",
        },
      },
      null,
      "WEB",
    );

    expect(classified()).toMatchObject({
      classification: "INDEPENDENT_CONTROLLER",
      status: null,
      counterparty: "Kartbolaget AB",
      termsConfirmed: null,
      subProcessorsAuthorised: null,
      note: "Bestammer sjalv over sina kartdata.",
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

  it("asks the record to keep a classification written since the check", async () => {
    /*
     * The refusal below is a read taken before the consent row. A board
     * classifying the plugin on the data protection screen in between is kept
     * by the write itself, which is the only place the two can meet.
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

    expect(recordProcessor.mock.calls[0]?.[3]).toEqual({
      onlyIfUnrecorded: true,
    });
  });
});

describe("an install for a plugin the record already classifies", () => {
  /*
   * The consent step asks only where the record has nothing, so an answer
   * arriving for a classified plugin comes from a tab opened before somebody
   * classified it, or from a caller of the API with no screen at all. Either
   * holds the permission to install plugins and not the one to change the
   * art. 28 record; recording the answer would let an update turn an agreement
   * the board recorded as in place back into one being made.
   */
  function classifiedAs(state: string) {
    return build({ recipients: new Map([["occupancy", state]]) });
  }

  it("refuses an update's answer over an agreement in place, and writes nothing", async () => {
    const built = classifiedAs("inPlace");

    const refusal: unknown = await built.service
      .install(
        {
          id: "occupancy",
          permissions: ["mail:send", "addressBook:read"],
          personalData: ["apartment", "name"],
          processorAgreement: {
            sendsPersonalDataOutside: true,
            recipient: "Belaggningstjansten AB",
            classification: "PROCESSOR",
            status: "PENDING",
          },
        },
        "admin-1",
        "WEB",
      )
      .catch((error: unknown) => error);

    // A reason of its own, so the screen can say what happened rather than
    // falling back to "the catalog may have changed".
    expect(refusal).toBeInstanceOf(PluginRecipientAlreadyRecordedError);
    expect(refusal).toMatchObject({
      status: 409,
      reason: "recipient-already-recorded",
    });

    // Refused before the first write, like every other answer the install
    // refuses: no consent row claiming an update that never happened.
    expect(built.recordProcessor).not.toHaveBeenCalled();
    expect(built.consent).not.toHaveBeenCalled();
    expect(built.seedPlugin).not.toHaveBeenCalled();
  });

  it.each(["pending", "notAProcessor", "independentController"])(
    "refuses an answer over a %s classification too",
    async (state) => {
      const built = classifiedAs(state);

      await expect(
        built.service.install(
          {
            id: "occupancy",
            permissions: ["mail:send", "addressBook:read"],
            personalData: ["apartment", "name"],
            processorAgreement: { sendsPersonalDataOutside: false },
          },
          "admin-1",
          "WEB",
        ),
      ).rejects.toThrow(PluginRecipientAlreadyRecordedError);

      expect(built.recordProcessor).not.toHaveBeenCalled();
    },
  );

  it("installs with no answer and leaves the record as it is", async () => {
    // What the consent step sends here: it shows what the record says and
    // asks nothing.
    const built = classifiedAs("inPlace");

    await built.service.install(
      {
        id: "occupancy",
        permissions: ["mail:send", "addressBook:read"],
        personalData: ["apartment", "name"],
      },
      "admin-1",
      "WEB",
    );

    expect(built.consent).toHaveBeenCalledTimes(1);
    expect(built.recordProcessor).not.toHaveBeenCalled();
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

  it("carries what the record of recipients says about the plugin", async () => {
    // The consent step keeps a recorded classification rather than asking
    // again, and a plugin removed and installed again still has one.
    const { service } = build({
      listed: [ENTRY],
      recipients: new Map([["occupancy", "inPlace"]]),
    });

    const { entries } = await service.browseCatalog();

    expect(entries[0]?.recipientState).toBe("inPlace");
  });

  it("says not recorded for a plugin the record does not name", async () => {
    const { service } = build({ listed: [ENTRY] });

    const { entries } = await service.browseCatalog();

    expect(entries[0]?.recipientState).toBe("notRecorded");
  });
});

/**
 * A deprecated entry is still listed, but should not be installed anew: the
 * curator's soft withdrawal of a package, which a label alone would not make.
 */
describe("a deprecated catalog entry", () => {
  const DEPRECATED = { ...ENTRY, deprecated: true } as CatalogPluginEntry;

  it("is refused as a first install, before anything is written", async () => {
    const { service, consent, record } = build({ entry: DEPRECATED });

    const refused = service.install({ id: ENTRY.id }, null, "WEB");

    await expect(refused).rejects.toBeInstanceOf(PluginEntryDeprecatedError);
    await expect(refused).rejects.toMatchObject({
      reason: "entry-deprecated",
      status: 409,
    });
    expect(consent).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
  });

  it("is refused when the cached copy of the catalog predates the deprecation", async () => {
    // The screen browsed the entry as available; the curator deprecated it
    // before the confirmation, inside the cache's lifetime.
    const { service, consent } = build({
      entry: DEPRECATED,
      cachedEntry: ENTRY,
    });

    await expect(
      service.install({ id: ENTRY.id }, null, "WEB"),
    ).rejects.toBeInstanceOf(PluginEntryDeprecatedError);
    expect(consent).not.toHaveBeenCalled();
  });

  it("is still installed again where the plugin is already installed", async () => {
    // Reinstalling and updating are how a board repairs or patches a plugin it
    // already depends on, and deprecation must not take that away.
    const { service, consent } = build({
      entry: DEPRECATED,
      installed: [{ id: ENTRY.id, manifest: null }],
    });

    await expect(
      service.install({ id: ENTRY.id }, null, "WEB"),
    ).resolves.toEqual({ restarting: true });
    expect(consent).toHaveBeenCalledOnce();
  });
});

/**
 * The restart an install or a removal ends in, as the overview reports it.
 *
 * The request is answered once the reconcile is queued, and the job then runs
 * the whole reconcile - npm included - before it hands over to the restart.
 * The screen that sent the request polls the overview meanwhile, and an
 * overview reporting nothing pending through that window tells it the
 * replacement is serving while the process answering is still the old one.
 */
describe("the restart an operation ends in", () => {
  it("is not pending before anything has asked for one", async () => {
    const { service } = build();

    expect((await service.overview()).restartPending).toBe(false);
  });

  it("is pending from the moment an install is accepted", async () => {
    const { service } = build();

    expect(await service.install({ id: ENTRY.id }, null, "WEB")).toEqual({
      restarting: true,
    });

    // The reconcile is queued and nothing has run it.
    expect((await service.overview()).restartPending).toBe(true);
  });

  it("is pending from the moment a removal is accepted", async () => {
    const { service } = build();

    expect(await service.uninstall(ENTRY.id, null, "WEB")).toEqual({
      restarting: true,
    });

    expect((await service.overview()).restartPending).toBe(true);
  });

  it("is not claimed for a removal while plugins are switched off", async () => {
    // No worker consumes the queue then, so the reconcile waits for a process
    // that has plugins on, and this one is not replaced. A screen told it was
    // would wait for a process that never comes.
    const { service } = build({ pluginsEnabled: false });

    expect(await service.uninstall(ENTRY.id, null, "WEB")).toEqual({
      restarting: false,
    });
    expect((await service.overview()).restartPending).toBe(false);
  });

  it("names the process that answered, which its replacement does not share", async () => {
    const before = build();
    const after = build();

    const answered = (await before.service.overview()).processId;

    expect(answered).toBe(before.restart.processId);
    expect(answered).not.toBe((await after.service.overview()).processId);
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

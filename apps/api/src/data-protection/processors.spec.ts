import { describe, expect, it, vi } from "vitest";

import type { Env } from "../config/env";
import type { FieldEncryptionService } from "../crypto/field-encryption.service";
import type { PrismaService } from "../database/prisma.service";
import { MailSettingsResolver } from "../mail/mail-settings";
import { ProcessorFactsService } from "./processor-facts.service";
import {
  currentProcessors,
  type OpenAgreementRow,
  type ProcessorFacts,
} from "./processors";

function facts(overrides: Partial<ProcessorFacts> = {}): ProcessorFacts {
  return {
    mailHost: "smtp.example.test",
    mailFromAddress: "styrelsen@granngarden.test",
    mailDriver: "settings",
    smsDriver: null,
    smsGatewayUrl: null,
    storageDriver: "local",
    s3Endpoint: null,
    s3Region: null,
    s3Bucket: null,
    installedPlugins: [],
    connectedApps: [],
    unencryptedStoredFiles: 0,
    mailbox: null,
    ...overrides,
  };
}

function row(overrides: Partial<OpenAgreementRow> = {}): OpenAgreementRow {
  return {
    processorKey: "smtp",
    classification: "PROCESSOR",
    status: "IN_PLACE",
    counterparty: "Mailleverantoren AB",
    ...overrides,
  };
}

function keys(descriptors: { processorKey: string }[]): string[] {
  return descriptors.map((descriptor) => descriptor.processorKey);
}

describe("currentProcessors", () => {
  it("lists the mail server when both the host and the sender are configured", () => {
    const descriptors = currentProcessors(facts(), []);

    expect(descriptors[0]).toMatchObject({
      processorKey: "smtp",
      processorKind: "SMTP",
      identity: "smtp.example.test",
      detail: "styrelsen@granngarden.test",
      state: "notRecorded",
    });
  });

  it("lists no mail server when the instance cannot send", () => {
    // A host with no sender address sends nothing, which the settings screen
    // already reports as an instance that cannot send.
    expect(
      keys(currentProcessors(facts({ mailFromAddress: null }), [])),
    ).not.toContain("smtp");
    expect(
      keys(currentProcessors(facts({ mailHost: null }), [])),
    ).not.toContain("smtp");
    expect(
      keys(currentProcessors(facts({ mailDriver: null }), [])),
    ).not.toContain("smtp");
  });

  it("lists no SMS recipient on an instance with no provider", () => {
    /*
     * An instance with no SMS provider hands nobody anything by that channel.
     * A row asking the board to classify a gateway it does not use would be a
     * false entry in a statutory record.
     */
    expect(keys(currentProcessors(facts(), []))).not.toContain("sms");
  });

  it("names the SMS gateway by its host once one is configured", () => {
    const descriptors = currentProcessors(
      facts({
        smsDriver: "http-gateway",
        smsGatewayUrl: "https://sms.example.test/v2/send",
      }),
      [],
    );

    expect(descriptors.find((d) => d.processorKey === "sms")).toMatchObject({
      processorKind: "SMS",
      identity: "sms.example.test",
    });
  });

  it("treats a driver named without its address as no provider at all", () => {
    // The rule selectedDriverKind already applies for the settings screen, so
    // the record and the screen cannot come apart.
    expect(
      keys(
        currentProcessors(
          facts({ smsDriver: "http-gateway", smsGatewayUrl: "  " }),
          [],
        ),
      ),
    ).not.toContain("sms");
  });

  it("suggests that the association's own disk is no processor", () => {
    const storage = currentProcessors(facts(), []).find(
      (descriptor) => descriptor.processorKey === "storage",
    );

    expect(storage).toMatchObject({
      // No name: there is no host to read and no bucket to quote, and a
      // placeholder here would reach a Swedish board as an English word. The
      // screen calls the row by its kind, in the reader's own language.
      identity: null,
      seededClassification: "NOT_A_PROCESSOR",
      state: "notRecorded",
    });
  });

  it("names an object store by endpoint and bucket, with the configured region beside it", () => {
    const storage = currentProcessors(
      facts({
        storageDriver: "s3",
        s3Endpoint: "https://s3.example.test",
        s3Bucket: "granngarden",
        s3Region: "eu-north-1",
      }),
      [],
    ).find((descriptor) => descriptor.processorKey === "storage");

    expect(storage).toMatchObject({
      identity: "https://s3.example.test / granngarden",
      detail: "eu-north-1",
      // No suggestion: where a bucket is, and who runs it, is the board's to
      // answer and not something the endpoint discloses.
      seededClassification: null,
    });
  });

  it("always lists hosting, because somebody runs the machine", () => {
    const descriptors = currentProcessors(facts(), []);

    expect(keys(descriptors)).toContain("hosting");
    // And with no name, for the same reason the local disk has none: the
    // instance cannot see who runs the machine it is running on. That row
    // exists to be answered by the only party who knows.
    expect(
      descriptors.find((descriptor) => descriptor.processorKey === "hosting"),
    ).toMatchObject({ identity: null, seededClassification: null });
  });

  it("lists the mailbox the board's letters are collected from, once one is configured", () => {
    /*
     * Every letter written to the board's address is held at the association's
     * mail provider, and the instance never deletes one there - a recipient
     * that exists, so it is listed. No suggestion: an association may run its
     * own mail server, which is no processor, and only the board knows which.
     */
    const descriptors = currentProcessors(
      facts({
        mailbox: {
          host: "pop.example.test",
          address: "styrelsen@granngarden.test",
        },
      }),
      [],
    );

    expect(
      descriptors.find((descriptor) => descriptor.processorKey === "mailbox"),
    ).toMatchObject({
      processorKind: "MAILBOX",
      identity: "pop.example.test",
      detail: "styrelsen@granngarden.test",
      seededClassification: null,
      state: "notRecorded",
    });
  });

  it("lists no mailbox where none is configured", () => {
    // Nothing is collected from a mailbox the board has not set up, and a row
    // asking it to classify one would be a false entry in a statutory record.
    expect(keys(currentProcessors(facts(), []))).not.toContain("mailbox");
  });

  it("lists one recipient per installed plugin, named by its package", () => {
    const descriptors = currentProcessors(
      facts({
        installedPlugins: [
          {
            id: "occupancy",
            packageName: "@openbrf/occupancy",
            version: "1.2.0",
          },
        ],
      }),
      [],
    );

    expect(
      descriptors.find((d) => d.processorKey === "plugin:occupancy"),
    ).toMatchObject({
      processorKind: "PLUGIN",
      identity: "@openbrf/occupancy",
      detail: "1.2.0",
      state: "notRecorded",
    });
  });

  it("lists one recipient per connected app, and suggests what it is", () => {
    /*
     * An app a member connected is their own tool: they chose it and it acts on
     * their instruction, so it decides its own purposes and art. 28 does not
     * reach it. The association engaged nobody, so there is no agreement to
     * seek - the classification is suggested rather than asked for, which is
     * what makes these rows different from the plugins above.
     */
    const descriptors = currentProcessors(
      facts({
        connectedApps: [
          {
            id: "client-1",
            name: "Anteckningsappen",
            host: "app.example.test",
          },
        ],
      }),
      [],
    );

    expect(
      descriptors.find((d) => d.processorKey === "connectedApp:client-1"),
    ).toMatchObject({
      processorKind: "EXTERNAL",
      identity: "Anteckningsappen",
      detail: "app.example.test",
      seededClassification: "INDEPENDENT_CONTROLLER",
      state: "notRecorded",
    });
  });

  it("names an app that declared no name by the host it is reached at", () => {
    // A recipient the record cannot call anything is worse than one called by
    // where it lives, and where it lives is what says which app it is.
    const descriptors = currentProcessors(
      facts({
        connectedApps: [
          { id: "client-2", name: null, host: "assistent.example.test" },
        ],
      }),
      [],
    );

    expect(
      descriptors.find((d) => d.processorKey === "connectedApp:client-2"),
    ).toMatchObject({ identity: "assistent.example.test", detail: null });
  });

  it("lists no connected app on an instance where nobody has connected one", () => {
    // A registered client nobody consented to has been handed nothing, so it is
    // not in the facts at all - the rule the SMS gateway above follows.
    expect(
      keys(currentProcessors(facts(), [])).some((key) =>
        key.startsWith("connectedApp:"),
      ),
    ).toBe(false);
  });

  it("joins a connected app to what the board recorded about it", () => {
    // One descriptor, not two: the row is joined to the app the facts already
    // name rather than producing a second recipient of its own.
    const descriptors = currentProcessors(
      facts({
        connectedApps: [
          {
            id: "client-1",
            name: "Anteckningsappen",
            host: "app.example.test",
          },
        ],
      }),
      [
        row({
          processorKey: "connectedApp:client-1",
          classification: "INDEPENDENT_CONTROLLER",
          status: null,
          counterparty: "Anteckningsappen AB",
        }),
      ],
    );

    expect(
      descriptors.filter((d) => d.processorKey === "connectedApp:client-1"),
    ).toHaveLength(1);
    expect(
      descriptors.find((d) => d.processorKey === "connectedApp:client-1")
        ?.state,
    ).toBe("independentController");
  });

  it("names a gateway that will not parse as a URL as it is written", () => {
    /*
     * A recipient left out of the record is worse than one named awkwardly, so
     * `hostOf` answers with the configured value rather than dropping the row.
     * The address has to be non-blank to reach that branch at all, because a
     * blank one is classified as no provider before a descriptor is built.
     */
    const descriptors = currentProcessors(
      facts({ smsDriver: "http-gateway", smsGatewayUrl: "sms-gateway" }),
      [],
    );

    expect(
      descriptors.find((descriptor) => descriptor.processorKey === "sms"),
    ).toMatchObject({ processorKind: "SMS", identity: "sms-gateway" });
  });

  it("falls back to the row's own id for a recipient with no counterparty", () => {
    // The board recorded the classification and left the name for later. The
    // record still has to be able to point at the row it is describing.
    const descriptors = currentProcessors(facts(), [
      row({
        processorKey: "external:clx1",
        classification: "INDEPENDENT_CONTROLLER",
        status: null,
        counterparty: null,
      }),
    ]);

    expect(
      descriptors.find((descriptor) => descriptor.processorKind === "EXTERNAL"),
    ).toMatchObject({ processorKey: "external:clx1", identity: "clx1" });
  });

  it("lists a board-recorded recipient by its counterparty", () => {
    const descriptors = currentProcessors(facts(), [
      row({
        processorKey: "external:clx1",
        classification: "PROCESSOR",
        status: "PENDING",
        counterparty: "Ekonomisk forvaltning AB",
      }),
    ]);

    expect(
      descriptors.find((d) => d.processorKind === "EXTERNAL"),
    ).toMatchObject({
      processorKey: "external:clx1",
      identity: "Ekonomisk forvaltning AB",
      state: "pending",
    });
  });

  describe("the state a recorded row produces", () => {
    it.each([
      ["an agreement in place", "PROCESSOR", "IN_PLACE", "inPlace"],
      ["an agreement being made", "PROCESSOR", "PENDING", "pending"],
      ["no processor", "NOT_A_PROCESSOR", null, "notAProcessor"],
      [
        "a controller of its own",
        "INDEPENDENT_CONTROLLER",
        null,
        "independentController",
      ],
    ])("reads %s", (_label, classification, status, expected) => {
      const descriptors = currentProcessors(facts(), [
        row({
          processorKey: "smtp",
          classification: classification as OpenAgreementRow["classification"],
          status: status as OpenAgreementRow["status"],
        }),
      ]);

      expect(descriptors[0]?.state).toBe(expected);
    });

    it("is notRecorded when the board has not been asked yet", () => {
      // The absence of a row, never a stored status: a stored "unrecorded"
      // would be a claim, and this is the lack of one.
      expect(currentProcessors(facts(), [])[0]?.state).toBe("notRecorded");
    });
  });
});

describe("the mail server, when whoever runs the instance sets the mail", () => {
  /**
   * The facts as the service reads them, over a board that stored an SMTP
   * server of its own before the environment set the mail (ADR 0024).
   */
  async function factsUnder(env: Env): Promise<ProcessorFacts> {
    const prisma = {
      association: {
        findUnique: vi.fn().mockResolvedValue({
          smtpHost: "smtp.stored.example",
          smtpFromAddress: "styrelsen@granngarden.test",
          smsDriver: null,
          smsGatewayUrl: null,
          boardMailboxAddress: null,
          boardMailboxPop3Host: null,
          boardMailboxPop3User: null,
          boardMailboxPop3PasswordCipher: null,
        }),
      },
      installedPlugin: { findMany: vi.fn().mockResolvedValue([]) },
      oauthClient: { findMany: vi.fn().mockResolvedValue([]) },
      mediaFile: { count: vi.fn().mockResolvedValue(0) },
    } as unknown as PrismaService;
    const encryption = {
      decrypt: vi.fn(),
    } as unknown as FieldEncryptionService;

    return new ProcessorFactsService(
      env,
      prisma,
      new MailSettingsResolver(env, prisma, encryption),
    ).read();
  }

  it("names the mail API's host rather than the server the board stored", async () => {
    // The recipient is the service mail actually goes through. Naming the
    // stored server would put a recipient in the register that receives
    // nothing, and leave out the one that receives everything.
    const descriptors = currentProcessors(
      await factsUnder({
        OPENBRF_STORAGE_DRIVER: "local",
        OPENBRF_MAIL_DRIVER: "http-api",
        OPENBRF_MAIL_FROM_ADDRESS: "utskick@delad.example",
        OPENBRF_MAIL_API_URL: "https://api.mail.example/v1",
        OPENBRF_MAIL_API_KEY: "key",
        OPENBRF_MAIL_API_MESSAGE_ID_DOMAIN: "mail.example",
      } as Env),
      [],
    );

    expect(descriptors.find((d) => d.processorKey === "mailApi")).toMatchObject(
      {
        processorKind: "MAIL_API",
        identity: "api.mail.example",
        detail: "utskick@delad.example",
      },
    );
    expect(keys(descriptors)).not.toContain("smtp");
  });

  it("names the environment's SMTP host", async () => {
    const descriptors = currentProcessors(
      await factsUnder({
        OPENBRF_STORAGE_DRIVER: "local",
        OPENBRF_MAIL_DRIVER: "smtp",
        OPENBRF_MAIL_FROM_ADDRESS: "utskick@delad.example",
        OPENBRF_SMTP_HOST: "smtp.host.example",
      } as Env),
      [],
    );

    expect(
      descriptors.find((d) => d.processorKey === "hostSmtp"),
    ).toMatchObject({
      processorKind: "HOST_SMTP",
      identity: "smtp.host.example",
    });
    expect(keys(descriptors)).not.toContain("smtp");
  });

  it("names the stored server while the environment sets nothing", async () => {
    const descriptors = currentProcessors(
      await factsUnder({
        OPENBRF_STORAGE_DRIVER: "local",
        OPENBRF_MAIL_DRIVER: "settings",
      } as Env),
      [],
    );

    expect(descriptors.find((d) => d.processorKey === "smtp")).toMatchObject({
      processorKind: "SMTP",
      identity: "smtp.stored.example",
    });
  });

  /*
   * The migration path: rows under "smtp" stay where they are, because that
   * key has always meant the board's own server. What changes is that the
   * host's mail is a recipient of its own, so the board's agreement is never
   * read as covering it.
   */
  it.each([
    ["smtp", "hostSmtp"],
    ["http-api", "mailApi"],
  ] as const)(
    "does not show the board's own agreement against the host's %s",
    (mailDriver, key) => {
      const descriptors = currentProcessors(
        facts({ mailDriver, mailHost: "relay.host.example" }),
        [row({ processorKey: "smtp" })],
      );

      expect(descriptors.find((d) => d.processorKey === key)?.state).toBe(
        "notRecorded",
      );
      expect(keys(descriptors)).not.toContain("smtp");
    },
  );

  it("shows the board's own agreement again once its settings send the mail", () => {
    const descriptors = currentProcessors(facts({ mailDriver: "settings" }), [
      row({ processorKey: "smtp" }),
    ]);

    expect(descriptors.find((d) => d.processorKey === "smtp")?.state).toBe(
      "inPlace",
    );
  });
});

import { PERSONAL_DATA_CATEGORIES } from "@openbrf/shared";
import type { TFunction } from "i18next";
import { describe, expect, it } from "vitest";

import { I18nService } from "../i18n/i18n.service";

import { PLUGIN_PERSONAL_DATA_CATEGORIES } from "@openbrf/plugin-sdk";

import {
  SEED_KEYS,
  seedRows,
  securityMeasuresFor,
} from "./processing-activity-seed";
import type { ProcessorFacts } from "./processors";

/**
 * A translator that echoes the key and any interpolation, so the assertions can
 * name what a row asked for without depending on the copy. Whether every key
 * resolves in Swedish and English is asserted in step 9's integration spec,
 * against the real catalogues.
 */
const t = ((key: string, values?: Record<string, unknown>) =>
  values === undefined
    ? key
    : `${key}(${Object.entries(values)
        .map(([name, value]) => `${name}=${String(value)}`)
        .join(",")})`) as unknown as TFunction;

function facts(overrides: Partial<ProcessorFacts> = {}): ProcessorFacts {
  return {
    smtpHost: "smtp.example.test",
    smtpFromAddress: "styrelsen@granngarden.test",
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

/**
 * An instance storing files in a bucket, with the board mailbox configured, so
 * the real-catalogue case below resolves the mailbox sentences too.
 */
const S3 = facts({
  storageDriver: "s3",
  s3Endpoint: "https://s3.example.test",
  s3Bucket: "granngarden",
  s3Region: "eu-north-1",
  mailbox: {
    host: "pop.example.test",
    address: "styrelsen@granngarden.test",
  },
});

/** An instance with the board mailbox configured, on the local driver. */
const MAILBOX = facts({
  mailbox: {
    host: "pop.example.test",
    address: "styrelsen@granngarden.test",
  },
});

/**
 * The rows that store files, and so name the storage and say whether the files
 * are encrypted. The board mailbox stores its attachments through the ordinary
 * upload path.
 */
const STORING_FILES = [
  "issues",
  "documents",
  "apartmentBinder",
  "websitePublication",
  "boardMailbox",
] as const;

/** An instance two members have connected apps to, one of them unnamed. */
const CONNECTED = facts({
  connectedApps: [
    { id: "client-1", name: "Anteckningsappen", host: "app.example.test" },
    { id: "client-2", name: null, host: "assistent.example.test" },
  ],
});

function rowFor(key: string, from: ProcessorFacts = facts()) {
  const row = seedRows(t, from).find(
    (candidate) => candidate.sourceKey === key,
  );
  if (row === undefined) {
    throw new Error(`no seeded row for ${key}`);
  }
  return row;
}

describe("SEED_KEYS", () => {
  it("names every processing the instance itself performs", () => {
    /*
     * A checked list rather than a derivation, deliberately: adding a table
     * that holds personal data should have to be given a row here, because a
     * processing the record does not mention is the failure art. 30 exists to
     * prevent.
     */
    expect([...SEED_KEYS]).toEqual([
      "memberRegister",
      "apartmentRegister",
      "cooperativeHousingRegisterReporting",
      "meetingRecords",
      "auditLog",
      "addressBookAndAccounts",
      "boardPositionsAndSystemRoles",
      "connectedApps",
      "residentDirectory",
      "newsMailings",
      "newsComments",
      "issues",
      "documents",
      "apartmentBinder",
      "bookings",
      "events",
      "motions",
      "subletApplications",
      "keyOrders",
      "chat",
      "boardMailbox",
      "fees",
      "memberCharges",
      "websitePublication",
      "contactSubmissions",
      "signupRequestsAndInvitations",
      "dataSubjectRequests",
      "personalDataBreaches",
      "legalHolds",
    ]);
  });

  it("has no duplicates, because the key is what makes seeding idempotent", () => {
    expect(new Set(SEED_KEYS).size).toBe(SEED_KEYS.length);
  });
});

describe("the plugin declaration and the record speak the same vocabulary", () => {
  it("spells the plugin categories exactly as the record does", () => {
    /*
     * The one place both packages can be imported. If these ever diverge, an
     * installed plugin's declared categories would need mapping before they
     * could become a processing activity, and a mapping is where a category
     * quietly turns into a different one.
     */
    for (const category of PLUGIN_PERSONAL_DATA_CATEGORIES) {
      expect(PERSONAL_DATA_CATEGORIES).toContain(category);
    }
  });

  it("keeps them at the head of the list, in the same order", () => {
    expect(
      PERSONAL_DATA_CATEGORIES.slice(0, PLUGIN_PERSONAL_DATA_CATEGORIES.length),
    ).toEqual([...PLUGIN_PERSONAL_DATA_CATEGORIES]);
  });
});

describe("seedRows", () => {
  it("writes one row per key", () => {
    expect(seedRows(t, facts()).map((row) => row.sourceKey)).toEqual([
      ...SEED_KEYS,
    ]);
  });

  it("puts the statutory registers on a legal obligation", () => {
    for (const key of [
      "memberRegister",
      "apartmentRegister",
      "cooperativeHousingRegisterReporting",
      "meetingRecords",
      "auditLog",
    ]) {
      expect(rowFor(key)).toMatchObject({
        source: "STATUTORY_REGISTER",
        legalBasis: "LEGAL_OBLIGATION",
      });
    }
  });

  it("names everybody the fee records say something about", () => {
    /*
     * A fee rate and a notice name an apartment, and the data subject access
     * report carries both to anybody whose residency overlaps them, whatever its
     * role - so a partner or a tenant living in the flat is a data subject of
     * this processing as much as the tenant-owner billed, and a record of
     * processing activities that left them out would be incomplete under GDPR
     * art. 30(1)(c). Former residents are there because the window outlives the
     * residency by years.
     */
    /*
     * The chat holds what somebody wrote for a year after they wrote it, on the
     * message's own clock, so a person who has moved out is still a data
     * subject of this processing: their words are on file and on their own
     * access report until that year runs out.
     */
    /*
     * The apartment binder for the same reason: the link to whoever filed an
     * entry stays until their own retention window runs out after they have
     * moved out, and their access report keeps listing what they filed. A
     * record naming only the people who are here would describe a processing
     * that stops when somebody leaves, and this one does not.
     */
    expect(rowFor("apartmentBinder").dataSubjectCategories).toEqual(
      expect.arrayContaining([
        "member",
        "resident",
        "boardMember",
        "formerResident",
      ]),
    );
    expect(rowFor("chat").dataSubjectCategories).toEqual(
      expect.arrayContaining(["formerResident"]),
    );
    expect(rowFor("fees").dataSubjectCategories).toEqual(
      expect.arrayContaining(["member", "resident", "formerResident"]),
    );
    expect(rowFor("fees")).toMatchObject({
      source: "SERVICE_DATA",
      legalBasis: "LEGAL_OBLIGATION",
    });

    /*
     * Every row whose clock is not the residency's names the people who have
     * moved, for the reason the chat and the binder give: a subletting
     * application is kept two years past the letting, a key order a year past
     * closing, a comment a year from writing, a charge through the accounting
     * archive's seven years, a thread two years from its last message, and a
     * position of trust for good.
     */
    for (const key of [
      "subletApplications",
      "keyOrders",
      "newsComments",
      "memberCharges",
      "boardMailbox",
      "boardPositionsAndSystemRoles",
    ]) {
      expect(rowFor(key).dataSubjectCategories, key).toContain(
        "formerResident",
      );
    }

    /*
     * And somebody outside the register. Whoever writes to the board is mostly
     * nobody the association holds; the sublessee is not recorded, but is who
     * a subletting application's reason is about and whose number turns up
     * pasted into it.
     */
    expect(rowFor("boardMailbox").dataSubjectCategories).toContain("external");
    expect(rowFor("subletApplications").dataSubjectCategories).toContain(
      "external",
    );
  });

  it("puts the charges beside the fees, on the bookkeeping obligation", () => {
    /*
     * A charge records a receivable arising, an affärshändelse under
     * bokföringslagen, and what documents it is kept through the seventh year
     * after the financial year ended. The contract would not explain why a
     * charge outlives the residency by seven years.
     */
    expect(rowFor("memberCharges")).toMatchObject({
      source: "SERVICE_DATA",
      legalBasis: "LEGAL_OBLIGATION",
    });
  });

  it("puts the association's own compliance records on a legal obligation and a legal hold on a legitimate interest", () => {
    /*
     * Answering a request about own data and documenting a breach are what the
     * GDPR itself requires (art. 12, art. 33(5)), which art. 6(3)(a) accepts as
     * the law laying the obligation down. A legal hold is not: art. 17(3)
     * disapplies erasure rather than supplying a basis, so keeping data for a
     * claim rests on the association's interest in the claim.
     */
    for (const key of ["dataSubjectRequests", "personalDataBreaches"]) {
      expect(rowFor(key), key).toMatchObject({
        source: "SERVICE_DATA",
        legalBasis: "LEGAL_OBLIGATION",
      });
    }
    expect(rowFor("legalHolds")).toMatchObject({
      source: "SERVICE_DATA",
      legalBasis: "LEGITIMATE_INTEREST",
    });
  });

  it("says an issue may carry health data the reporter volunteered", () => {
    // Nothing asks for it, but a person describing why the cold is a problem
    // may write it, and a record that did not say so would be inaccurate.
    expect(rowFor("issues").personalDataCategories).toContain("health");
  });

  it("says a letter to the board may carry health, money and photographs", () => {
    // Whatever somebody chose to write to their association arrives: money,
    // health, a dispute with a neighbour, and pictures of people.
    expect(rowFor("boardMailbox").personalDataCategories).toEqual(
      expect.arrayContaining(["health", "financial", "photograph", "freeText"]),
    );
  });

  it("names the mail server and the gateway as the recipients of a mailing", () => {
    expect(
      rowFor(
        "newsMailings",
        facts({
          smsDriver: "http-gateway",
          smsGatewayUrl: "https://sms.example.test/send",
        }),
      ).recipients,
    ).toBe("smtp.example.test, https://sms.example.test/send");
  });

  it("says so when there is no mail server to name", () => {
    expect(rowFor("newsMailings", facts({ smtpHost: null })).recipients).toBe(
      "dataProtection.processing.seed.recipients.noMailServer",
    );
  });

  it("names the association's own disk under the local driver", () => {
    for (const key of STORING_FILES) {
      // Last, after whatever else the row names: the board mailbox names its
      // mailbox first.
      expect(rowFor(key).recipients, key).toMatch(
        /(^| )dataProtection\.processing\.seed\.recipients\.localDisk$/,
      );
      expect(rowFor(key).thirdCountryTransfer).toBe(false);
      expect(rowFor(key).thirdCountrySafeguards).toBeNull();
    }
  });

  it("names the endpoint and the bucket under the s3 driver", () => {
    expect(rowFor("documents", S3).recipients).toBe(
      "dataProtection.processing.seed.recipients.s3(endpoint=https://s3.example.test,bucket=granngarden)",
    );
  });

  it("flags a transfer the board has to answer for, with the configured region", () => {
    /*
     * Conservative on purpose. An object store the association does not run is
     * data leaving to a host the instance cannot place, and the region is
     * printed as what the driver signs with rather than as a claim about where
     * the bucket is - the board places it and then clears the flag.
     */
    const row = rowFor("issues", S3);

    expect(row.thirdCountryTransfer).toBe(true);
    expect(row.thirdCountrySafeguards).toBe(
      "dataProtection.processing.seed.storageTransfer(endpoint=https://s3.example.test,bucket=granngarden,region=eu-north-1)",
    );
  });

  it("leaves rows that store no files out of the transfer question", () => {
    expect(rowFor("memberRegister", S3).thirdCountryTransfer).toBe(false);
    expect(rowFor("bookings", S3).recipients).toBeNull();
  });

  it("names the mailbox, the mail server replies go through and the storage for the board mailbox", () => {
    /*
     * The letters arrive at the association's mail provider and stay there,
     * the board's answers leave through the instance's own mail server, and
     * the attachments are stored like any other upload: three recipients, in
     * that order.
     */
    expect(rowFor("boardMailbox", MAILBOX).recipients).toBe(
      "dataProtection.processing.seed.recipients.mailbox(host=pop.example.test) " +
        "dataProtection.processing.seed.recipients.replies(host=smtp.example.test) " +
        "dataProtection.processing.seed.recipients.localDisk",
    );
  });

  it("says so when no mailbox is configured", () => {
    expect(rowFor("boardMailbox").recipients).toBe(
      "dataProtection.processing.seed.recipients.noMailbox " +
        "dataProtection.processing.seed.recipients.localDisk",
    );
  });

  it("leaves replies out when the instance cannot send", () => {
    // A host with no sender address sends nothing, which is the test the mail
    // row and the processor list apply.
    expect(
      rowFor("boardMailbox", { ...MAILBOX, smtpFromAddress: null }).recipients,
    ).toBe(
      "dataProtection.processing.seed.recipients.mailbox(host=pop.example.test) " +
        "dataProtection.processing.seed.recipients.localDisk",
    );
  });

  it("names the economic manager as the recipient of the charges and the fees", () => {
    /*
     * The debiting list and the accounting basis go to whoever keeps the books.
     * No setting names that party, so the row says who it is rather than
     * guessing at a name.
     */
    for (const key of ["memberCharges", "fees"]) {
      expect(rowFor(key).recipients, key).toBe(
        "dataProtection.processing.seed.recipients.economicManager",
      );
    }
  });

  it("flags the board mailbox's attachments as a transfer under the s3 driver, and not its mail host", () => {
    /*
     * The attachments are stored files and follow the storage rule; the mail
     * host follows the mail rule, which flags nothing. So the safeguards name
     * the bucket and never the mailbox.
     */
    const row = rowFor("boardMailbox", S3);

    expect(row.thirdCountryTransfer).toBe(true);
    expect(row.thirdCountrySafeguards).toBe(
      "dataProtection.processing.seed.storageTransfer(endpoint=https://s3.example.test,bucket=granngarden,region=eu-north-1)",
    );
    expect(rowFor("boardMailbox", MAILBOX).thirdCountryTransfer).toBe(false);
  });

  it("names every connected app as a recipient, by where it is reached", () => {
    /*
     * The one processing whose whole purpose is handing data to something
     * outside the instance. A row naming no recipients would be the record
     * being silent about exactly the disclosure it exists to describe.
     */
    expect(rowFor("connectedApps", CONNECTED).recipients).toBe(
      "app.example.test, assistent.example.test",
    );
  });

  it("flags a transfer the board has to answer for once an app is connected", () => {
    /*
     * Conservative for the same reason the bucket is, and more so: a client is
     * a program the member runs, at an address the app chose, on a machine the
     * instance has no way of locating at all. The board clears the flag for the
     * apps its members use, or names the art. 46 safeguard.
     */
    const row = rowFor("connectedApps", CONNECTED);

    expect(row.thirdCountryTransfer).toBe(true);
    expect(row.thirdCountrySafeguards).toBe(
      "dataProtection.processing.seed.clientTransfer(clients=app.example.test, assistent.example.test)",
    );
  });

  it("says so, and records no transfer, when nobody has connected anything", () => {
    // Nothing is handed anywhere while there is nobody to hand it to, and a
    // transfer recorded against an empty list would be a false entry.
    const row = rowFor("connectedApps");

    expect(row.recipients).toBe(
      "dataProtection.processing.seed.recipients.noConnectedApps",
    );
    expect(row.thirdCountryTransfer).toBe(false);
    expect(row.thirdCountrySafeguards).toBeNull();
  });

  it("keeps the storage sentence off the connected apps row", () => {
    // Two kinds of transfer on one record, and each has to say where its own
    // data went: the bucket sentence here would name a recipient this row has
    // nothing to do with.
    const row = seedRows(t, {
      ...S3,
      connectedApps: CONNECTED.connectedApps,
    }).find((candidate) => candidate.sourceKey === "connectedApps");

    expect(row?.thirdCountrySafeguards).toContain(
      "dataProtection.processing.seed.clientTransfer",
    );
    expect(row?.thirdCountrySafeguards).not.toContain("storageTransfer");
  });
});

describe("securityMeasuresFor", () => {
  it("names encryption at rest only where contact or identity data is held", () => {
    // art. 30(1)(g) asks what protects this processing. Claiming field-level
    // encryption for a table that has none would be worse than saying nothing.
    expect(securityMeasuresFor("addressBookAndAccounts", facts(), t)).toContain(
      "dataProtection.processing.security.encryptionAtRest",
    );
    expect(securityMeasuresFor("auditLog", facts(), t)).not.toContain(
      "dataProtection.processing.security.encryptionAtRest",
    );
  });

  it("always names the capability gates and the audit log", () => {
    for (const key of SEED_KEYS) {
      const text = securityMeasuresFor(key, facts(), t);
      expect(text).toContain(
        "dataProtection.processing.security.capabilityGates",
      );
      expect(text).toContain("dataProtection.processing.security.auditLog");
    }
  });

  it("names the driver in use for a processing that stores files", () => {
    expect(securityMeasuresFor("documents", facts(), t)).toContain(
      "dataProtection.processing.security.localDisk",
    );
    expect(securityMeasuresFor("documents", S3, t)).toContain(
      "dataProtection.processing.security.s3(endpoint=https://s3.example.test)",
    );
  });

  it("leaves the storage sentence off a processing that stores nothing", () => {
    const text = securityMeasuresFor("bookings", S3, t);

    expect(text).not.toContain("dataProtection.processing.security.s3");
    expect(text).not.toContain("dataProtection.processing.security.localDisk");
  });

  it("says the files are encrypted on every processing that stores them, once every file is", () => {
    for (const key of STORING_FILES) {
      expect(securityMeasuresFor(key, facts(), t), key).toContain(
        "dataProtection.processing.security.filesEncrypted",
      );
      expect(securityMeasuresFor(key, S3, t), key).toContain(
        "dataProtection.processing.security.filesEncrypted",
      );
    }
  });

  it("does not say it while one stored file is still unencrypted", () => {
    // The job at start has not finished with a file an older instance stored,
    // or has not yet removed the unencrypted object it replaced.
    for (const key of STORING_FILES) {
      expect(
        securityMeasuresFor(key, facts({ unencryptedStoredFiles: 1 }), t),
        key,
      ).not.toContain("dataProtection.processing.security.filesEncrypted");
    }
  });

  it("does not claim masking where people are named as they wrote", () => {
    /*
     * The masking of protected personal data reaches the people the register
     * names. A correspondent, whoever writes through the contact form, and
     * whoever asks for an account are shown as they wrote themselves in, so
     * saying they are masked would be a false statement in the record.
     */
    for (const key of [
      "boardMailbox",
      "contactSubmissions",
      "signupRequestsAndInvitations",
    ] as const) {
      const text = securityMeasuresFor(key, facts(), t);
      expect(text, key).toContain(
        "dataProtection.processing.security.namedAsWritten",
      );
      expect(text, key).not.toContain(
        "dataProtection.processing.security.protectedPersons",
      );
    }

    // A subletting application names the tenant-owner from the register, who
    // is masked like everywhere else.
    expect(securityMeasuresFor("subletApplications", facts(), t)).toContain(
      "dataProtection.processing.security.protectedPersons",
    );
  });

  it("never says it of a processing that stores no files", () => {
    for (const key of SEED_KEYS.filter(
      (candidate) => !(STORING_FILES as readonly string[]).includes(candidate),
    )) {
      expect(securityMeasuresFor(key, facts(), t), key).not.toContain(
        "dataProtection.processing.security.filesEncrypted",
      );
    }
  });
});

describe("the seed text in the real catalogues", () => {
  it("resolves every key each row asks for, in both languages", async () => {
    /*
     * The echoing translator above proves the rows ask for the right keys. This
     * proves the keys exist: a seeded record naming
     * "dataProtection.processing.seed.memberRegister.name" would be a board's
     * first sight of its own art. 30 record, and it would look like a bug
     * because it is one.
     */
    const i18n = new I18nService();
    await i18n.init();

    /*
     * Over both kinds of instance: one with a mailbox, a bucket and a mail
     * server, and one with none of them, so every sentence a configuration can
     * select - the mailbox and the replies, and saying there is no mailbox and
     * no mail server - resolves.
     */
    for (const [locale, from] of [
      ["sv", S3],
      ["en", S3],
      ["sv", facts({ smtpHost: null })],
      ["en", facts({ smtpHost: null })],
    ] as const) {
      const translate = i18n.translatorFor(locale);
      for (const row of seedRows(translate, from)) {
        for (const [field, value] of Object.entries(row)) {
          if (typeof value !== "string") {
            continue;
          }
          expect(value, `${locale} ${row.sourceKey}.${field}`).not.toContain(
            "dataProtection.processing",
          );
          expect(value.trim(), `${locale} ${row.sourceKey}.${field}`).not.toBe(
            "",
          );
        }
      }
    }
  });
});

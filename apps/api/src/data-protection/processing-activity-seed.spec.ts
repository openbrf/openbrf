import { PERSONAL_DATA_CATEGORIES } from "@openbrf/shared";
import type { TFunction } from "i18next";
import { describe, expect, it } from "vitest";

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
    ...overrides,
  };
}

const S3 = facts({
  storageDriver: "s3",
  s3Endpoint: "https://s3.example.test",
  s3Bucket: "granngarden",
  s3Region: "eu-north-1",
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
      "residentDirectory",
      "newsMailings",
      "issues",
      "documents",
      "bookings",
      "events",
      "motions",
      "websitePublication",
      "contactSubmissions",
      "signupRequestsAndInvitations",
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

  it("says an issue may carry health data the reporter volunteered", () => {
    // Nothing asks for it, but a person describing why the cold is a problem
    // may write it, and a record that did not say so would be inaccurate.
    expect(rowFor("issues").personalDataCategories).toContain("health");
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
    for (const key of ["issues", "documents", "websitePublication"]) {
      expect(rowFor(key).recipients).toBe(
        "dataProtection.processing.seed.recipients.localDisk",
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
});

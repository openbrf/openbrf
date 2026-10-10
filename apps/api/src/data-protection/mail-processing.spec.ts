import type { TFunction } from "i18next";
import { describe, expect, it } from "vitest";

import { erasureSourceFacts } from "../testing/erasure-source-facts";
import { MAIL_TEMPLATES, seedRows } from "./processing-activity-seed";
import type { ProcessorFacts } from "./processors";

/**
 * That every mail the instance sends is sent under a row of the record of
 * processing activities that names the mail server.
 *
 * GDPR art. 30(1)(d) asks the record for every recipient, and a hosted mail
 * provider receives each address and each message. The rows that say so used
 * to be a list kept in the seed, and the breach reminder and the reporting
 * obligation notice both mailed every board member from rows that were not on
 * it. So each template now declares the row it is sent under, the seed reads
 * the list from the templates, and this spec finds the templates by walking the
 * source rather than by asking the list: a mailer added later is held to the
 * rule without anybody remembering it.
 */

/**
 * A translator that echoes the key and what it interpolates, so a host named
 * inside a sentence - where the board's replies leave - is still there to find.
 */
const t = ((key: string, values?: Record<string, unknown>) =>
  values === undefined
    ? key
    : `${key}(${Object.values(values).map(String).join(",")})`) as unknown as TFunction;

/**
 * An instance that can send mail and collects the board's mailbox, so every
 * row that mails anybody has a mail server to name.
 */
const FACTS: ProcessorFacts = {
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
  mailbox: { host: "pop.example.test", address: "styrelsen@granngarden.test" },
};

/**
 * The mails sent on no processing the association records, and why. A
 * template is added here deliberately or not at all.
 */
const NOT_A_RECORDED_PROCESSING: Record<string, string> = {
  "plugin-message":
    "a plugin's own processing, consented to by the board with the categories the plugin declared",
};

const facts = erasureSourceFacts();
const declared = facts.flatMap((file) =>
  file.mailTemplateIds.map((id) => ({ path: file.path, id })),
);

describe("the mail the instance sends", () => {
  it("finds the templates in the source", () => {
    // A walk that found none would pass every assertion below.
    expect(declared.length).toBeGreaterThan(10);
  });

  it("is every template declared anywhere in the source, and nothing else", () => {
    for (const template of declared) {
      expect(
        template.id,
        `${template.path} declares a mail template whose id is not a literal`,
      ).not.toBeNull();
    }
    const byId = (a: string | null, b: string | null): number =>
      String(a).localeCompare(String(b));
    expect(MAIL_TEMPLATES.map((template) => template.id).sort(byId)).toEqual(
      declared.map((template) => template.id).sort(byId),
    );
  });

  it.each(MAIL_TEMPLATES.map((template) => [template.id, template] as const))(
    "sends %s under a row that names the mail server",
    (id, template) => {
      if (template.processing === null) {
        expect(
          NOT_A_RECORDED_PROCESSING[id],
          `${id} declares no processing and is not one of the mails sent on none`,
        ).toBeDefined();
        return;
      }
      const row = seedRows(t, FACTS).find(
        (candidate) => candidate.sourceKey === template.processing,
      );
      expect(row?.recipients).toContain("smtp.example.test");
      expect(row?.personalDataCategories).toContain("email");
    },
  );
});

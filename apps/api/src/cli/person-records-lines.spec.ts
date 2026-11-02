import type { PluginPersonRecordCollection } from "@openbrf/plugin-sdk";
import { beforeAll, describe, expect, it } from "vite-plus/test";

import { FALLBACK_LOCALE, I18nService } from "../i18n/i18n.service";
import { personRecordsLines } from "./person-records-lines";

/**
 * What `openbrf plugin add` prints about the records a plugin keeps about a
 * person: the consent screen's sentences, in the fallback locale.
 */

const i18n = new I18nService();

beforeAll(async () => {
  await i18n.init();
});

const ADS: PluginPersonRecordCollection = {
  collection: "wanted-ads",
  titleKey: "records.wantedAds.title",
  personalData: ["name"],
  keepAtMostDays: 60,
  fields: [],
};

describe("personRecordsLines", () => {
  const t = () => i18n.translatorFor(FALLBACK_LOCALE);
  const categories = (values: readonly string[]) => values.join(", ");

  it("prints nothing for a plugin that keeps no records about a person", () => {
    expect(personRecordsLines([], t(), categories)).toEqual([]);
  });

  it("prints each collection with its bound, and what the host does", () => {
    expect(personRecordsLines([ADS], t(), categories)).toEqual([
      "  Records it keeps about a person",
      "    wanted-ads: name. Each record is kept at most 60 days.",
      `    ${t()("plugins.consent.personRecords.host")}`,
    ]);
  });

  it("says that a collection declaring showsSubject may show a person's name at their own choice (ADR 0053)", () => {
    const lines = personRecordsLines(
      [
        { ...ADS, showsSubject: true },
        { ...ADS, collection: "replies" },
      ],
      t(),
      categories,
    );

    expect(lines).toEqual([
      "  Records it keeps about a person",
      "    wanted-ads: name. Each record is kept at most 60 days.",
      `      ${t()("plugins.consent.personRecords.showsSubject", { collection: "wanted-ads" })}`,
      "    replies: name. Each record is kept at most 60 days.",
      `    ${t()("plugins.consent.personRecords.host")}`,
    ]);
    expect(lines[2]).toContain(
      "wanted-ads may show a person's name, and a resident's apartment",
    );
  });
});

import { PLUGIN_INSTALL_FAILURE_REASONS } from "@openbrf/shared";
import { beforeAll, describe, expect, it } from "vitest";

import { I18nService, SUPPORTED_LOCALES } from "../i18n/i18n.service";
import {
  INSTALL_FAILURE_LABEL_KEYS,
  installFailureLabelKey,
} from "./plugin-labels";

/**
 * The install failure keys the command-line tool translates.
 *
 * The table is typed against the reason list, so a reason without a key does
 * not compile. What the compiler cannot see from here is the resources: this
 * file is the check that every key the table names is a sentence in every
 * locale, rather than a key i18next would print back as it stands.
 */

const i18n = new I18nService();

beforeAll(async () => {
  await i18n.init();
});

describe("INSTALL_FAILURE_LABEL_KEYS", () => {
  it.each([...PLUGIN_INSTALL_FAILURE_REASONS])(
    "has a sentence for %s in every locale",
    (reason) => {
      const key = INSTALL_FAILURE_LABEL_KEYS[reason];
      // A sentence that names a number of seconds has a form per plural, and
      // only resolves when it is given the count; one that does not ignores it.
      for (const count of [1, 2]) {
        const sentences = SUPPORTED_LOCALES.map((locale) =>
          i18n.translatorFor(locale)(key, { count }),
        );

        // i18next prints a missing key back as it stands, and falls back to
        // English for a locale missing one, so a sentence per locale is one
        // that is neither the key nor another locale's.
        expect(sentences).not.toContain(key);
        expect(new Set(sentences).size).toBe(SUPPORTED_LOCALES.length);
      }
    },
  );

  it("gives no two reasons the same sentence", () => {
    const keys = Object.values(INSTALL_FAILURE_LABEL_KEYS);

    expect(new Set(keys).size).toBe(PLUGIN_INSTALL_FAILURE_REASONS.length);
  });
});

describe("installFailureLabelKey", () => {
  it("reads a known reason through the table", () => {
    expect(installFailureLabelKey("checksum-mismatch")).toBe(
      "plugins.installed.failure.checksumMismatch",
    );
  });

  it("reads a reason a later version wrote as unrecognised", () => {
    const t = i18n.translatorFor("en");

    expect(
      t(installFailureLabelKey("registry-on-fire"), {
        reason: "registry-on-fire",
      }),
    ).toBe(
      "The installation failed for a reason this version has no wording for: registry-on-fire",
    );
  });
});

import type { PluginProcessing } from "@openbrf/plugin-sdk";
import { beforeAll, describe, expect, it } from "vite-plus/test";

import { FALLBACK_LOCALE, I18nService } from "../i18n/i18n.service";
import { processingLines } from "./processing-lines";

/**
 * What `openbrf plugin add` prints about a plugin's processing of personal
 * data: every field of the declaration as the consent screen's own sentences,
 * in the fallback locale, with the catalog's text made safe for the terminal.
 */

const i18n = new I18nService();

beforeAll(async () => {
  await i18n.init();
});

const PROCESSING: PluginProcessing = {
  purpose: { sv: "Visa namn i trapphuset", en: "Show names in the stairwell" },
  legalBasis: "contract",
  retention: { sv: "Tills personen flyttar", en: "Until the person moves out" },
  dataSubjects: ["residents", "members"],
};

describe("processingLines", () => {
  const t = () => i18n.translatorFor(FALLBACK_LOCALE);

  it("prints every field of the declaration", () => {
    const lines = processingLines(
      {
        personalData: ["name"],
        processing: PROCESSING,
        installedVersion: null,
      },
      t(),
    );

    expect(lines).toEqual([
      "  What the processing is for",
      "    Purpose: Show names in the stairwell",
      "    Legal basis: the membership contract (art. 6(1)(b))",
      "    Kept: Until the person moves out",
      "    Whose data: residents, members",
    ]);
  });

  it("names the interest relied on for a processing on legitimate interest", () => {
    const lines = processingLines(
      {
        personalData: ["name"],
        processing: {
          ...PROCESSING,
          legalBasis: "legitimateInterest",
          legitimateInterest: {
            sv: "Att hitta rätt dörr",
            en: "Finding the right door",
          },
        },
        installedVersion: null,
      },
      t(),
    );

    expect(lines).toContain(
      "    Legal basis: legitimate interest (art. 6(1)(f)). The interest: Finding the right door",
    );
  });

  it("says so where a plugin names personal data and declares no processing", () => {
    const lines = processingLines(
      { personalData: ["name"], processing: null, installedVersion: null },
      t(),
    );

    expect(lines).toEqual([
      "  What the processing is for",
      `    ${t()("plugins.consent.processing.undeclared")}`,
    ]);
    // Translated, not the key: a missing key would print itself.
    expect(lines.join("\n")).not.toContain("plugins.consent");
  });

  it("prints nothing for a plugin that handles nobody's data", () => {
    expect(
      processingLines(
        { personalData: [], processing: null, installedVersion: null },
        t(),
      ),
    ).toEqual([]);
  });

  it("says where the board's wording is kept on an update", () => {
    const lines = processingLines(
      {
        personalData: ["name"],
        processing: PROCESSING,
        installedVersion: "1.0.0",
      },
      t(),
    );

    expect(lines.at(-1)).toBe(
      `    ${t()("plugins.consent.processing.update")}`,
    );
  });

  it("shows a control character in the catalog's text rather than sending it", () => {
    const lines = processingLines(
      {
        personalData: ["name"],
        processing: {
          ...PROCESSING,
          purpose: { sv: "Syfte", en: "Purpose\u001b[2J" },
          retention: { sv: "Tid", en: "A year‮" },
        },
        installedVersion: null,
      },
      t(),
    );

    const printed = lines.join("\n");
    expect(printed).not.toContain("\u001b");
    expect(printed).not.toContain("‮");
    expect(printed).toContain("Purpose\\x1b[2J");
  });
});

import { beforeAll, describe, expect, it } from "vitest";

import { I18nService } from "./i18n.service";

/**
 * Locale resolution guards a rule with legal weight: correspondence goes out
 * in the recipient's language, and the recipient's stored locale is untrusted
 * input from an import or a form.
 */
describe("I18nService", () => {
  let service: I18nService;

  beforeAll(async () => {
    service = new I18nService();
    await service.init();
  });

  it("renders in the recipient's locale, not a global current language", () => {
    const swedish = service.translatorFor("sv");
    const english = service.translatorFor("en");

    // Both translators stay valid at the same time, which is what sending one
    // mailing to residents with different locales requires.
    expect(swedish("welcome.tagline")).toBe("Föreningen äger sin data");
    expect(english("welcome.tagline")).toBe("The association owns its data");
  });

  it.each([
    ["sv", "sv"],
    ["en", "en"],
    ["sv-SE", "sv"],
    ["EN-GB", "en"],
    ["  sv  ", "sv"],
  ])("resolves the language tag %s to %s", (input, expected) => {
    expect(service.resolveLocale(input)).toBe(expected);
  });

  it.each([[null], [undefined], [""], ["de"], ["nonsense"]])(
    "falls back to Swedish for the unsupported value %s",
    (input) => {
      expect(service.resolveLocale(input)).toBe("sv");
    },
  );

  it("merges plugin resources under a namespace of their own", () => {
    service.addPluginResources("occupancy-summary", {
      sv: { heading: "Belaggning" },
      en: { heading: "Occupancy" },
    });

    const swedish = service.translatorFor("sv");
    expect(swedish("plugin-occupancy-summary:heading")).toBe("Belaggning");
    expect(
      service.translatorFor("en")("plugin-occupancy-summary:heading"),
    ).toBe("Occupancy");
  });

  it("keeps a plugin from overwriting a core key", () => {
    service.addPluginResources("rogue", {
      sv: { "welcome.tagline": "Hijacked" },
    });

    expect(service.translatorFor("sv")("welcome.tagline")).toBe(
      "Föreningen äger sin data",
    );
  });
});

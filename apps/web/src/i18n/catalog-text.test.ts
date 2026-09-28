import { describe, expect, it } from "vitest";

import { catalogText } from "./catalog-text";

/**
 * A catalog entry's text arrives in both languages; the screen shows one.
 * i18next reports a regional Swedish locale as `sv-SE` as readily as `sv`, and
 * anything that is not Swedish falls back to English, as the interface does.
 */
describe("catalogText", () => {
  const text = { sv: "Exempeltema", en: "Example theme" };

  it("gives the Swedish text for a Swedish locale, regional or not", () => {
    expect(catalogText(text, "sv")).toBe("Exempeltema");
    expect(catalogText(text, "sv-SE")).toBe("Exempeltema");
  });

  it("gives the English text for English and for anything else", () => {
    expect(catalogText(text, "en")).toBe("Example theme");
    expect(catalogText(text, "de")).toBe("Example theme");
  });
});

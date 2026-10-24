import { readFileSync } from "node:fs";

import { describe, expect, it } from "vite-plus/test";

import { translate } from "./translate.ts";
import { WORDS } from "./words.ts";

function screenContentWords(locale: "en" | "sv"): unknown {
  const file = new URL(
    `../../i18n/src/locales/${locale}.json`,
    import.meta.url,
  );
  return JSON.parse(readFileSync(file, "utf8")).screenContent;
}

describe("the renderer's words", () => {
  it.each(["en", "sv"] as const)(
    "are the screenContent namespace of %s.json; run `pnpm --filter @openbrf/display words` after changing it",
    (locale) => {
      expect(WORDS[locale]).toEqual(screenContentWords(locale));
    },
  );

  it("have the same keys in Swedish as in English", () => {
    expect(Object.keys(WORDS.sv).sort()).toEqual(Object.keys(WORDS.en).sort());
  });
});

describe("translate", () => {
  it("fills placeholders", () => {
    expect(translate("en", "lastUpdated", { time: "14:05" })).toBe(
      "Last updated 14:05",
    );
  });

  it("picks the plural form by the locale's rules", () => {
    expect(translate("en", "placesLeft", { count: 1 })).toBe("1 place left");
    expect(translate("en", "placesLeft", { count: 3 })).toBe("3 places left");
    expect(translate("sv", "placesLeft", { count: 1 })).toBe("1 plats kvar");
    expect(translate("sv", "placesLeft", { count: 3 })).toBe("3 platser kvar");
  });

  it("speaks Swedish", () => {
    expect(translate("sv", "comingEvents")).toBe("Kommande evenemang");
  });
});

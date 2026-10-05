import { describe, expect, it } from "vitest";

import {
  isValidPersonalIdentityNumber,
  normalizePersonalIdentityNumber,
  parsePersonalIdentityNumber,
  normalizeFreeText,
  normalizeSingleLineText,
  scanForPersonalIdentityNumbers,
} from "./personal-identity-number.ts";

/**
 * The canonical form these functions produce is the storage format of every
 * blind index (ADR 0002). The table below is therefore a compatibility suite
 * rather than a set of examples: a change that alters one byte of an output
 * silently breaks search on data already stored, and the only lawful way to
 * make one of these fail is a migration that recomputes every index.
 */

// Fixed so century inference is deterministic rather than dependent on today.
const REFERENCE = new Date("2026-08-27T00:00:00Z");

describe("normalizePersonalIdentityNumber", () => {
  it.each([
    ["811228-9874", "198112289874"],
    ["8112289874", "198112289874"],
    ["19811228-9874", "198112289874"],
    ["198112289874", "198112289874"],
    [" 811228 - 9874 ", "198112289874"],
    // Without a century, the most recent year that is not in the future.
    ["121212-1212", "201212121212"],
    // A plus separator means the person has turned 100.
    ["121212+1212", "191212121212"],
    // A coordination number keeps the +60 day offset, so the form round-trips.
    ["121272-1219", "201212721219"],
    ["000229-0120", "200002290120"],
  ])("writes %s as %s, byte for byte", (written, canonical) => {
    expect(normalizePersonalIdentityNumber(written, REFERENCE)).toBe(canonical);
  });

  it("returns null rather than an unmatchable index for bad input", () => {
    expect(normalizePersonalIdentityNumber("nonsense", REFERENCE)).toBeNull();
    expect(normalizePersonalIdentityNumber("12121-1212", REFERENCE)).toBeNull();
  });
});

describe("parsePersonalIdentityNumber", () => {
  it("resolves the century and keeps the day as written", () => {
    expect(parsePersonalIdentityNumber("121272-1219", REFERENCE)).toEqual({
      year: 2012,
      month: 12,
      day: 72,
      suffix: "1219",
      isCoordinationNumber: true,
    });
  });

  it("refuses a date that never existed, whatever the check digit says", () => {
    // 30 February 2026, with a correct Luhn digit.
    expect(parsePersonalIdentityNumber("260230-0127", REFERENCE)).toBeNull();
  });
});

describe("isValidPersonalIdentityNumber", () => {
  it("accepts a number whose check digit holds", () => {
    expect(isValidPersonalIdentityNumber("811228-9874", REFERENCE)).toBe(true);
  });

  it("refuses one whose check digit does not", () => {
    expect(isValidPersonalIdentityNumber("811228-9875", REFERENCE)).toBe(false);
  });
});

/**
 * The scanner exists for the moment before something is published. Nothing the
 * association puts on its public website may carry an identity number, and the
 * two properties that matter are opposite: it must find one however it is
 * written, and it must not cry wolf over the numbers a page legitimately
 * carries - an organisation number, a phone number, an amount, a date.
 */
describe("scanForPersonalIdentityNumbers", () => {
  it.each([
    "Ring Anna på 811228-9874 om du undrar.",
    "Ring Anna på 8112289874 om du undrar.",
    "Ring Anna på 19811228-9874 om du undrar.",
    "Ring Anna på 198112289874 om du undrar.",
    // A coordination number is an identity number too.
    "Ring Anna på 121272-1219 om du undrar.",
  ])("finds the number in %s", (text) => {
    expect(scanForPersonalIdentityNumbers(text, REFERENCE)).toHaveLength(1);
  });

  it("reports the number as written, and where it sits", () => {
    const text = "Styrelsen nås via 811228-9874.";

    expect(scanForPersonalIdentityNumbers(text, REFERENCE)).toEqual([
      { value: "811228-9874", index: text.indexOf("811228-9874") },
    ]);
  });

  it("finds every number in a text that carries more than one", () => {
    const text =
      "Ordförande 811228-9874, kassör 121212-1212 och suppleant 121272-1219.";

    expect(
      scanForPersonalIdentityNumbers(text, REFERENCE).map(
        (match) => match.value,
      ),
    ).toEqual(["811228-9874", "121212-1212", "121272-1219"]);
  });

  it("leaves an organisation number alone", () => {
    /*
     * A housing cooperative prints its own organisation number in its footer,
     * and that number carries a correct Luhn digit like any other. What keeps
     * it out is the calendar: the third digit pair of an organisation number
     * is always 20 or more, which is never a month. The day the scanner starts
     * reporting these, the board is asked to remove a lawful value from a page
     * it belongs on - so this is the case that must not regress.
     */
    const text = "Brf Sjötungan, organisationsnummer 769600-1234.";

    expect(scanForPersonalIdentityNumbers(text, REFERENCE)).toEqual([]);
  });

  it.each([
    // A Swedish mobile number written compactly is the same shape; the check
    // digit is what refuses it.
    "Ring 0701234567 så hjälper vi till.",
    // A longer run of digits must not yield a ten-digit window out of its
    // middle: no candidate may touch a digit on either side.
    "Referens 1198112289874 gäller fakturan.",
    "Kortnummer 4111111111111111 hör inte hemma här.",
    // Separated by spaces, so the parts are separate numbers.
    "Ring 070-123 45 67 om du undrar.",
    "Årsstämman hölls 2026-04-15 i föreningslokalen.",
    "Avgiften är 4 250 kronor i månaden.",
  ])("finds nothing in %s", (text) => {
    expect(scanForPersonalIdentityNumbers(text, REFERENCE)).toEqual([]);
  });

  it.each([
    ["a soft hyphen", "Ring Anna på 811228\u00AD-9874 om du undrar."],
    ["a zero-width space", "Ring Anna på 811228-\u200B9874 om du undrar."],
    ["a zero-width joiner", "Ring Anna på 81\u200D1228-9874 om du undrar."],
    ["fullwidth digits", "Ring Anna på ８１１２２８-９８７４ om du undrar."],
    ["a fullwidth hyphen", "Ring Anna på 811228\uFF0D9874 om du undrar."],
    ["a byte order mark", "Ring Anna på 811228\uFEFF-9874 om du undrar."],
    ["a word joiner", "Ring Anna på 811228\u2060-9874 om du undrar."],
    [
      "a combining grapheme joiner",
      "Ring Anna på 811228\u034F-9874 om du undrar.",
    ],
    ["a variation selector", "Ring Anna på 811228\uFE0F-9874 om du undrar."],
    ["a Hangul filler", "Ring Anna på 811228\u3164-9874 om du undrar."],
  ])("finds a number hidden behind %s", (_name, text) => {
    expect(scanForPersonalIdentityNumbers(text, REFERENCE)).toHaveLength(1);
  });

  it("reports a hidden number where it sits in the text it was given", () => {
    const text = "Nr \u200B811228\u00AD-9874 nu";
    const [hit] = scanForPersonalIdentityNumbers(text, REFERENCE);

    // From the first digit to the last, invisible characters inside included.
    expect(hit?.index).toBe(text.indexOf("8"));
    expect(hit?.value).toBe("811228\u00AD-9874");
  });

  it.each([
    ["spaces around the hyphen", "811228 - 9874"],
    ["a space before the hyphen", "811228 -9874"],
    ["a space after the hyphen", "811228- 9874"],
    ["a space instead of the hyphen", "811228 9874"],
    ["a plus between spaces", "811228 + 9874"],
    ["the century and a space", "19811228 9874"],
    ["the halves on two lines", "811228-\n9874"],
    ["the halves on two lines, no hyphen", "811228\r\n9874"],
  ])(
    "finds a number written with %s, as the parser reads it",
    (_name, written) => {
      expect(
        scanForPersonalIdentityNumbers(`Godkänd av ${written}.`, REFERENCE),
      ).toEqual([{ value: written, index: "Godkänd av ".length }]);
    },
  );

  it("reports a number hidden behind a byte order mark where it sits in the text", () => {
    const text = "Nr 811228\uFEFF-9874 nu";
    const [hit] = scanForPersonalIdentityNumbers(text, REFERENCE);

    expect(hit?.index).toBe(text.indexOf("8"));
    expect(hit?.value).toBe("811228\uFEFF-9874");
  });

  it.each(["\t", "\r", "\u0085", "\u2028", "\u00A0", "\u3000"])(
    "finds a number whose halves %j separates, as it does a space",
    (separator) => {
      expect(
        scanForPersonalIdentityNumbers(
          `Ring 811228${separator}9874`,
          REFERENCE,
        ),
      ).toHaveLength(1);
    },
  );

  it.each([
    // A space inside the date or inside the last four is still a boundary.
    "Ring 8112 28-9874 om du undrar.",
    "Ring 811228-98 74 om du undrar.",
    // A date and an unrelated figure after it fail the check digit.
    "Stämman 811228 1234 kronor.",
  ])("finds nothing in %s", (text) => {
    expect(scanForPersonalIdentityNumbers(text, REFERENCE)).toEqual([]);
  });

  it("finds a number in the raw text whenever it finds one in the normalised text", () => {
    const number = "811228-9874";
    const hidden = [
      "\u00AD",
      "\u200B",
      "\u200D",
      "\u2060",
      "\u034F",
      "\uFE0F",
      "\uFEFF",
      "\u180E",
      "\u3164",
      "\u0000",
      "\u001F",
      "\u{E0020}",
      "\t",
      "\n",
      "\r",
      "\u0085",
      "\u2028",
    ];
    for (const character of hidden) {
      for (let at = 1; at < number.length; at++) {
        const text = number.slice(0, at) + character + number.slice(at);
        const seen = scanForPersonalIdentityNumbers(text, REFERENCE).length;
        const stored = scanForPersonalIdentityNumbers(
          normalizeFreeText(text),
          REFERENCE,
        ).length;
        expect(seen, JSON.stringify(text)).toBeGreaterThanOrEqual(stored);
      }
    }
  });

  it("finds nothing in an empty text", () => {
    expect(scanForPersonalIdentityNumbers("", REFERENCE)).toEqual([]);
  });

  it("gives up on a date followed by a long run of spaces in linear time", () => {
    /*
     * A page block is scanned as one text, and can be a megabyte. A pattern
     * whose whitespace runs overlap takes about n²/2 steps on this input: some
     * sixteen seconds at this length, with the API's event loop stopped for
     * all of it.
     */
    const text = `19811228${" ".repeat(200_000)}`;

    const started = performance.now();
    const found = scanForPersonalIdentityNumbers(text, REFERENCE);
    const elapsed = performance.now() - started;

    expect(found).toEqual([]);
    expect(elapsed).toBeLessThan(1_000);
  });

  it("does not carry a match from one scan into the next", () => {
    const text = "Ring Anna på 811228-9874.";

    expect(scanForPersonalIdentityNumbers(text, REFERENCE)).toHaveLength(1);
    expect(scanForPersonalIdentityNumbers(text, REFERENCE)).toHaveLength(1);
  });
});

describe("normalizeFreeText", () => {
  it("removes what cannot be seen and folds what looks like something else", () => {
    expect(normalizeFreeText("a\u00ADb\u200Bc\u0000de")).toBe("abcde");
    expect(normalizeFreeText("８１１２２８－９８７４")).toBe("811228-9874");
  });

  it("removes a byte order mark, a word joiner and the marks a renderer draws as nothing", () => {
    expect(normalizeFreeText("811228\uFEFF-9874")).toBe("811228-9874");
    expect(normalizeFreeText("8112\u206028\u034F-\uFE0F9874")).toBe(
      "811228-9874",
    );
  });

  it("keeps line breaks, so two lines do not join into one run", () => {
    expect(normalizeFreeText("line one\nline two\ttab\r\n")).toBe(
      "line one\nline two\ttab\r\n",
    );
  });

  it("is its own normal form when removing a character lets a mark compose", () => {
    const text = "e\u200B\u0301";

    expect(normalizeFreeText(normalizeFreeText(text))).toBe(
      normalizeFreeText(text),
    );
    expect(normalizeFreeText(text)).toBe("\u00E9");
  });

  it("is idempotent for every code point that is dropped, combines or folds, alone and beside a base letter and a mark", () => {
    // The rest of Unicode passes through unchanged, so looping over it would
    // only spend the time limit: what can change is what is invisible, a
    // separator, a mark that composes, or has a compatibility form. Unassigned
    // and private-use code points are all dropped the same way, so a sample of
    // them stands for the roughly 950 000 of them.
    const relevant = /[\p{C}\p{Default_Ignorable_Code_Point}\p{M}\p{Z}]/u;
    const alike = /[\p{Cn}\p{Co}]/u;

    for (let point = 0; point <= 0x10ffff; point++) {
      if (point >= 0xd800 && point <= 0xdfff) {
        continue;
      }
      const character = String.fromCodePoint(point);
      if (alike.test(character) && point % 251 !== 0) {
        continue;
      }
      if (
        !relevant.test(character) &&
        character.normalize("NFKC") === character
      ) {
        continue;
      }
      for (const text of [
        character,
        `e${character}\u0301`,
        `${character}\u0301a`,
      ]) {
        const once = normalizeFreeText(text);
        if (normalizeFreeText(once) !== once) {
          throw new Error(`not idempotent for U+${point.toString(16)}`);
        }
      }
    }
  });

  it("leaves ordinary text, Swedish letters included, as it is", () => {
    expect(normalizeFreeText("Årsstämma i föreningslokalen")).toBe(
      "Årsstämma i föreningslokalen",
    );
  });
});

describe("normalizeSingleLineText", () => {
  it("turns a line break into a space rather than joining the lines", () => {
    expect(normalizeSingleLineText("  Ritning\nbadrum\t\u200B 2  ")).toBe(
      "Ritning badrum 2",
    );
  });

  it("treats a next-line character as a line break", () => {
    expect(normalizeSingleLineText("Ritning\u0085badrum")).toBe(
      "Ritning badrum",
    );
    expect(normalizeSingleLineText("\u0085Ritning\u0085")).toBe("Ritning");
  });

  it("gives nothing for a text made only of invisible characters", () => {
    expect(normalizeSingleLineText("\u200B\uFEFF \n")).toBe("");
  });
});

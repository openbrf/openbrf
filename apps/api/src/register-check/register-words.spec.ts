import { describe, expect, it } from "vite-plus/test";

import { normalizePhone } from "../crypto/personal-data";
import {
  emailAddressesIn,
  findRegisterWords,
  phoneNumbersIn,
  type RegisterName,
  registerWordsOf,
} from "./register-words";

/**
 * How the register check finds the register's names and apartment numbers in
 * published text, and what it cuts out of the text to look up as an email
 * address or a phone number (ADR 0032).
 */

function person(
  givenName: string,
  familyName: string,
  protectedPersonalData = false,
): RegisterName {
  return { givenName, familyName, protectedPersonalData };
}

function found(
  text: string,
  names: readonly RegisterName[],
  apartmentNumbers: readonly string[] = [],
): { words: string; protectedOnly: boolean }[] {
  return findRegisterWords(text, registerWordsOf(names, apartmentNumbers));
}

function words(
  text: string,
  names: readonly RegisterName[],
  apartmentNumbers: readonly string[] = [],
): string[] {
  return found(text, names, apartmentNumbers).map((match) => match.words);
}

describe("findRegisterWords", () => {
  const SVENSSON = person("Anna", "Svensson");

  it("finds a family name as a whole word, whatever its case", () => {
    expect(words("Tack till svensson för hjälpen.", [SVENSSON])).toEqual([
      "svensson",
    ]);
    expect(words("SVENSSON", [SVENSSON])).toEqual(["SVENSSON"]);
    expect(words("Svenssonska stiftelsen", [SVENSSON])).toEqual([]);
  });

  it("finds a name in the genitive", () => {
    expect(words("Svenssons grill är lånad.", [SVENSSON])).toEqual([
      "Svenssons",
    ]);
    expect(words("Annas cykel står kvar.", [SVENSSON])).toEqual(["Annas"]);
    expect(words("Svenssonss", [SVENSSON])).toEqual([]);
    expect(words("Anna Svenssons cykel", [SVENSSON])).toEqual([
      "Anna Svenssons",
    ]);
    // An apartment number has no genitive.
    expect(words("1101s", [], ["1101"])).toEqual(["1101"]);
  });

  it("finds a given name only where it begins with a capital", () => {
    const per = person("Per", "Lindqvist");

    expect(words("Per hälsar alla välkomna.", [per])).toEqual(["Per"]);
    expect(words("En lott per hushåll.", [per])).toEqual([]);
  });

  it("finds each of several given names, and a double name by either half", () => {
    const names = [person("Anna Maria", "Ek"), person("Karl-Johan", "Berg")];

    expect(words("Hälsningar från Maria", names)).toEqual(["Maria"]);
    expect(words("Johan fixar grillen", names)).toEqual(["Johan"]);
  });

  it("reports a whole name once, and its words where they stand alone", () => {
    expect(words("Anna Svensson och Svensson igen", [SVENSSON])).toEqual([
      "Anna Svensson",
      "Svensson",
    ]);
  });

  it("finds a family name's capitalised parts alone, and never its particle", () => {
    const platen = person("Gustaf", "von Platen");

    expect(words("Platen har nycklarna", [platen])).toEqual(["Platen"]);
    expect(words("von Platen har nycklarna", [platen])).toEqual(["von Platen"]);
    expect(words("Brev von der Heide", [platen])).toEqual([]);
  });

  it("never finds an initial on its own", () => {
    expect(words("A och B", [person("A", "B")])).toEqual([]);
  });

  it("finds an apartment number as a word, beside letters too", () => {
    expect(
      words("Nyckeln till lgh 1101 och lgh1102", [], ["1101", "1102"]),
    ).toEqual(["1101", "1102"]);
    expect(words("Kod 11011, kl. 11.01", [], ["1101"])).toEqual([]);
  });

  it("finds an apartment number of one character only after a word for one", () => {
    expect(
      words(
        "Nyckeln till lgh 7, sedan lägenhet 8 och lgh. nr 9",
        [],
        ["7", "8", "9"],
      ),
    ).toEqual(["lgh 7", "lägenhet 8", "nr 9"]);
    expect(words("Lgh7", [], ["7"])).toEqual(["Lgh7"]);
    expect(words("Städdag 7 maj", [], ["7"])).toEqual([]);
  });

  it("is not fooled by invisible characters or compatibility forms", () => {
    // A soft hyphen and a zero-width space inside the name, and a full-width S.
    expect(words("Tack Svens­son", [SVENSSON])).toEqual(["Svensson"]);
    expect(words("Tack Svens​son", [SVENSSON])).toEqual(["Svensson"]);
    expect(words("Tack Ｓvensson", [SVENSSON])).toEqual(["Svensson"]);
  });

  describe("protected personal data", () => {
    const hidden = person("Hemlig", "Hemligsson", true);

    it("marks a word that names only persons with protected personal data", () => {
      expect(found("Hälsa på Hemligsson", [hidden])).toEqual([
        { words: "Hemligsson", protectedOnly: true },
      ]);
    });

    it("shows a word somebody without protected personal data has as well", () => {
      expect(
        found("Hälsa på Hemligsson", [hidden, person("Bo", "Hemligsson")]),
      ).toEqual([{ words: "Hemligsson", protectedOnly: false }]);
    });

    it("never shows a protected word because a shown name stands next to it", () => {
      // Anna is somebody else's given name; Hemligsson is only the protected
      // person's, and "Anna Hemligsson" would be their whole name were it hers.
      expect(
        found("Grattis Anna Hemligsson!", [
          SVENSSON,
          person("Anna", "Hemligsson", true),
        ]),
      ).toEqual([
        { words: "Anna", protectedOnly: false },
        { words: "Hemligsson", protectedOnly: true },
      ]);
    });
  });
});

describe("emailAddressesIn", () => {
  it("cuts out each address whole", () => {
    expect(
      emailAddressesIn("Skriv till anna@example.se eller joanna@example.se."),
    ).toEqual(["anna@example.se", "joanna@example.se"]);
  });

  it("finds nothing where there is no address", () => {
    expect(emailAddressesIn("Möte @ 18.00 i lokalen")).toEqual([]);
  });

  it.each([
    ["without an @", "a".repeat(100_000)],
    ["before a trailing @", `${"a".repeat(100_000)}@`],
    [
      "before an @ and a long label",
      `${"a".repeat(50_000)}@${"b".repeat(50_000)}`,
    ],
    ["of repeated @", "a@".repeat(50_000)],
  ])("reads a long unbroken run %s in linear time", (_name, text) => {
    const started = performance.now();
    expect(emailAddressesIn(text)).toEqual([]);
    expect(performance.now() - started).toBeLessThan(500);
  });

  it("cuts a local part longer than an address has at its last 64 characters", () => {
    expect(emailAddressesIn(`${"a".repeat(100)}@example.se`)).toEqual([
      `${"a".repeat(64)}@example.se`,
    ]);
  });
});

describe("phoneNumbersIn", () => {
  const normalized = (text: string) => phoneNumbersIn(text).map(normalizePhone);

  it.each([
    ["070-123 45 67"],
    ["0701234567"],
    ["+46 70 123 45 67"],
    ["+46 (0)70 123 45 67"],
    ["070 12 34 567"],
    // An en dash, a hyphen, a minus sign, a tab and narrow spaces.
    ["070–123 45 67"],
    ["070 – 123 45 67"],
    ["070‐123 45 67"],
    ["070−123 45 67"],
    ["070-123\t45 67"],
    ["070 123 45 67"],
  ])("finds the number however %s is spaced", (written) => {
    expect(normalized(`Ring ${written} vid frågor`)).toContain("+46701234567");
  });

  it("never splits a group of digits", () => {
    expect(phoneNumbersIn("Kod 112345678")).not.toContain("1234567");
  });

  it("finds a number after a long run of other numbers", () => {
    const list = Array.from({ length: 30 }, (_, index) => String(index)).join(
      " ",
    );

    expect(normalized(`${list} 070-123 45 67`)).toContain("+46701234567");
  });
});

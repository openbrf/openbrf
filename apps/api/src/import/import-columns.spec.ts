import en from "@openbrf/i18n/locales/en.json";
import sv from "@openbrf/i18n/locales/sv.json";
import { describe, expect, it } from "vitest";

import {
  normalizeHeader,
  parseImportDate,
  parseRole,
  splitFullName,
  suggestMapping,
  validateMapping,
} from "./import-columns";

describe("normalizing a column title", () => {
  it("reads the same title written three ways as one", () => {
    expect(normalizeHeader("E-postadress")).toBe("e postadress");
    expect(normalizeHeader("  e_post_adress ")).toBe("e post adress");
    expect(normalizeHeader("EPOSTADRESS")).toBe("epostadress");
  });

  it("folds Swedish vowels so a title matches whatever the keyboard produced", () => {
    expect(normalizeHeader("Lägenhetsnummer")).toBe("lagenhetsnummer");
    expect(normalizeHeader("Förnamn")).toBe("fornamn");
  });
});

describe("guessing the mapping", () => {
  it("recognises a Swedish member list", () => {
    expect(
      suggestMapping([
        "Lgh",
        "Förnamn",
        "Efternamn",
        "Roll",
        "E-post",
        "Telefon",
      ]),
    ).toEqual([
      "apartmentNumber",
      "firstName",
      "lastName",
      "role",
      "email",
      "phone",
    ]);
  });

  it("recognises an English one", () => {
    expect(
      suggestMapping(["Apartment number", "Name", "Email", "Moved in on"]),
    ).toEqual(["apartmentNumber", "fullName", "email", "movedInOn"]);
  });

  it("leaves a column it does not recognise unmapped rather than guessing", () => {
    expect(suggestMapping(["Anteckning", "Lgh"])).toEqual([
      null,
      "apartmentNumber",
    ]);
  });

  it("does not give one field to two columns", () => {
    // "Namn" and "Förnamn" both look like a name. The first claims fullName and
    // the second is left to claim firstName, rather than the later column
    // silently taking a field the earlier one already has.
    expect(suggestMapping(["Namn", "Förnamn"])).toEqual([
      "fullName",
      "firstName",
    ]);
  });

  it("keeps the street address and the postal address apart", () => {
    expect(suggestMapping(["Adress", "Postadress"])).toEqual([
      "addressLabel",
      "postalStreet",
    ]);
  });

  it("maps every column of the template it hands out, in both languages", () => {
    // The template exists so a board does not have to map anything by hand. A
    // title that the guesser does not recognise would make the file it produced
    // no better than any other spreadsheet.
    for (const locale of [sv, en]) {
      const titles = Object.values(locale.import.template.column);
      const mapped = suggestMapping(titles);

      expect(mapped.filter((field) => field === null)).toEqual([]);
      expect(new Set(mapped).size).toBe(titles.length);
    }
  });
});

describe("checking a mapping before anything is read", () => {
  const complete = [
    "apartmentNumber",
    "fullName",
    "role",
    "movedInOn",
  ] as const;

  it("accepts a mapping that can identify a person and an apartment", () => {
    expect(
      validateMapping({
        mapping: [...complete],
        columnCount: 4,
        defaultRole: null,
        defaultMovedInOn: null,
      }),
    ).toEqual([]);
  });

  it("refuses a mapping with no name", () => {
    expect(
      validateMapping({
        mapping: ["apartmentNumber", "role", "movedInOn"],
        columnCount: 3,
        defaultRole: null,
        defaultMovedInOn: null,
      }),
    ).toContain("name-column-missing");
  });

  it("accepts a first name and a last name in place of one name column", () => {
    expect(
      validateMapping({
        mapping: [
          "apartmentNumber",
          "firstName",
          "lastName",
          "role",
          "movedInOn",
        ],
        columnCount: 5,
        defaultRole: null,
        defaultMovedInOn: null,
      }),
    ).toEqual([]);
  });

  it("refuses a file with no role unless a role was chosen for it", () => {
    // A blank cell read as "member" writes an entry in a register that cannot
    // be deleted, so nothing may guess it.
    const mapping = ["apartmentNumber", "fullName", "movedInOn"] as const;

    expect(
      validateMapping({
        mapping: [...mapping],
        columnCount: 3,
        defaultRole: null,
        defaultMovedInOn: null,
      }),
    ).toContain("role-missing");
    expect(
      validateMapping({
        mapping: [...mapping],
        columnCount: 3,
        defaultRole: "RESIDENT",
        defaultMovedInOn: null,
      }),
    ).toEqual([]);
  });

  it("refuses a file with no move-in date unless one was chosen for it", () => {
    expect(
      validateMapping({
        mapping: ["apartmentNumber", "fullName", "role"],
        columnCount: 3,
        defaultRole: null,
        defaultMovedInOn: null,
      }),
    ).toContain("moved-in-missing");
  });

  it("refuses two columns mapped to the same field", () => {
    expect(
      validateMapping({
        mapping: [
          "fullName",
          "fullName",
          "apartmentNumber",
          "role",
          "movedInOn",
        ],
        columnCount: 5,
        defaultRole: null,
        defaultMovedInOn: null,
      }),
    ).toContain("duplicate-field:fullName");
  });

  it("refuses a mapping that is not the width of the file", () => {
    expect(
      validateMapping({
        mapping: [...complete],
        columnCount: 7,
        defaultRole: null,
        defaultMovedInOn: null,
      }),
    ).toContain("mapping-length-mismatch");
  });
});

describe("splitting one name column", () => {
  it("takes the last word as the surname", () => {
    expect(splitFullName("Anna Maria Lindqvist")).toEqual({
      firstName: "Anna Maria",
      lastName: "Lindqvist",
    });
  });

  it("refuses a single word rather than inventing an empty first name", () => {
    expect(splitFullName("Lindqvist")).toBeNull();
  });
});

describe("reading a role", () => {
  it("reads the Swedish words a board writes", () => {
    expect(parseRole("Medlem")).toBe("MEMBER");
    expect(parseRole("bostadsrättshavare")).toBe("MEMBER");
    expect(parseRole("Boende")).toBe("RESIDENT");
    expect(parseRole("hyresgäst")).toBe("RESIDENT");
  });

  it("reads the English ones too", () => {
    expect(parseRole("Member")).toBe("MEMBER");
    expect(parseRole("resident")).toBe("RESIDENT");
  });

  it("refuses a word it does not know rather than defaulting", () => {
    expect(parseRole("styrelse")).toBeNull();
    expect(parseRole("")).toBeNull();
  });
});

describe("reading a date", () => {
  it("accepts an ISO calendar date", () => {
    expect(parseImportDate("2020-03-01")).toBe("2020-03-01");
  });

  it("refuses an ambiguous format", () => {
    // 03/04/2026 is two different days depending on who wrote it, and a
    // membership date six months wrong cannot be corrected by editing.
    expect(parseImportDate("03/04/2026")).toBeNull();
    expect(parseImportDate("1 mars 2020")).toBeNull();
  });

  it("refuses a day that never existed", () => {
    expect(parseImportDate("2026-02-30")).toBeNull();
  });
});

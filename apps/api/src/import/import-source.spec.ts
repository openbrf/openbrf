import { describe, expect, it } from "vite-plus/test";

import { contentDigestOf, savedMapping, sourceKeyOf } from "./import-source";

/**
 * How a file is recognised as one the board has imported from before, and as
 * the very rows it imported last time.
 */

describe("the key a source is recognised by", () => {
  it("is the same for titles that differ only in case and surrounding space", () => {
    expect(sourceKeyOf(["Lägenhet", " Namn ", "E-post"])).toBe(
      sourceKeyOf(["lägenhet", "namn", "E-POST"]),
    );
  });

  it("is the same for a title written with a combining accent", () => {
    expect(sourceKeyOf(["Lägenhet"])).toBe(sourceKeyOf(["Lägenhet"]));
  });

  it("differs when the columns have moved", () => {
    expect(sourceKeyOf(["Namn", "Lägenhet"])).not.toBe(
      sourceKeyOf(["Lägenhet", "Namn"]),
    );
  });

  it("differs when a column has been added", () => {
    expect(sourceKeyOf(["Namn", "Lägenhet"])).not.toBe(
      sourceKeyOf(["Namn", "Lägenhet", "Telefon"]),
    );
  });

  it("does not run two titles together", () => {
    expect(sourceKeyOf(["ab", "c"])).not.toBe(sourceKeyOf(["a", "bc"]));
  });
});

describe("the digest of a file's rows", () => {
  it("is the same for the same rows", () => {
    expect(contentDigestOf([["Namn"], ["Anna"]])).toBe(
      contentDigestOf([["Namn"], ["Anna"]]),
    );
  });

  it("changes with one cell", () => {
    expect(contentDigestOf([["Namn"], ["Anna"]])).not.toBe(
      contentDigestOf([["Namn"], ["Anne"]]),
    );
  });

  it("does not run two cells together", () => {
    expect(contentDigestOf([["ab", "c"]])).not.toBe(
      contentDigestOf([["a", "bc"]]),
    );
  });
});

describe("the mapping offered for a source", () => {
  const source = {
    mapping: ["apartmentNumber", "", "fullName"],
    defaultRole: "MEMBER" as const,
    defaultMovedInOn: "2020-01-01",
    mappingSavedAt: new Date("2026-10-01T10:00:00.000Z"),
  };

  it("is the one saved, column by column", () => {
    expect(savedMapping(source, 3)).toEqual({
      mapping: ["apartmentNumber", null, "fullName"],
      defaultRole: "MEMBER",
      defaultMovedInOn: "2020-01-01",
      mappingSavedAt: "2026-10-01T10:00:00.000Z",
    });
  });

  it("is none the first time", () => {
    expect(savedMapping(null, 3)).toBeNull();
  });

  it("is none when it does not fit the file", () => {
    expect(savedMapping(source, 4)).toBeNull();
  });
});

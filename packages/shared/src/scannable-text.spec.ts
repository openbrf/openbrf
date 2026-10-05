import { describe, expect, it } from "vitest";

import { scannableRuns } from "./scannable-text.ts";

/**
 * The API refuses and the editor warns from this one reading, so what it
 * leaves out is left out of both.
 */
describe("scannableRuns", () => {
  it("is the words alone when nothing links", () => {
    expect(scannableRuns([{ text: "Hej " }, { text: "alla" }])).toEqual({
      words: "Hej alla",
      addresses: [],
    });
  });

  it("reads each address apart from the words", () => {
    expect(
      scannableRuns([
        { text: "Skriv", link: "mailto:a@exempel.se?subject=19811218-9876" },
        { text: " till oss" },
      ]),
    ).toEqual({
      words: "Skriv till oss",
      addresses: ["mailto:a@exempel.se?subject=19811218-9876"],
    });
  });

  it("reads an escaped address decoded as well as written", () => {
    expect(
      scannableRuns([
        { text: "Skriv", link: "mailto:a@exempel.se?subject=19811218%2D9876" },
      ]).addresses,
    ).toEqual([
      "mailto:a@exempel.se?subject=19811218%2D9876",
      "mailto:a@exempel.se?subject=19811218-9876",
    ]);
  });

  it("reads an address that cannot be decoded as written", () => {
    expect(
      scannableRuns([{ text: "Se", link: "/sida?rabatt=50%" }]).addresses,
    ).toEqual(["/sida?rabatt=50%"]);
  });
});

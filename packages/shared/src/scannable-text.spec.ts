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

  it("reads an address with nothing to decode as written", () => {
    expect(
      scannableRuns([{ text: "Se", link: "/sida?rabatt=50%" }]).addresses,
    ).toEqual(["/sida?rabatt=50%"]);
  });

  it("decodes the escapes it can when a stray % stands beside them", () => {
    // One % that begins no escape used to stop the whole address from being
    // decoded, and the number spelled with %2D went unread.
    expect(
      scannableRuns([
        {
          text: "Skriv",
          link: "mailto:a@exempel.se?subject=50%&body=19811218%2D9876",
        },
      ]).addresses,
    ).toEqual([
      "mailto:a@exempel.se?subject=50%&body=19811218%2D9876",
      "mailto:a@exempel.se?subject=50%&body=19811218-9876",
    ]);
  });

  it("decodes an address escaped twice down to what it says", () => {
    expect(
      scannableRuns([
        { text: "Skriv", link: "mailto:a@exempel.se?body=19811218%252D9876" },
      ]).addresses,
    ).toEqual([
      "mailto:a@exempel.se?body=19811218%252D9876",
      "mailto:a@exempel.se?body=19811218%2D9876",
      "mailto:a@exempel.se?body=19811218-9876",
    ]);
  });

  it("decodes the plain escapes beside a broken multi-byte one", () => {
    // %E4 alone is not UTF-8, which made the run beside it undecodable too.
    expect(
      scannableRuns([{ text: "Se", link: "/s?q=19811218%E4%2D9876" }])
        .addresses,
    ).toEqual(["/s?q=19811218%E4%2D9876", "/s?q=19811218%E4-9876"]);
  });
});

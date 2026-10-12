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
      unreadableAddress: false,
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
      unreadableAddress: false,
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

  it("decodes an address escaped four times all the way down", () => {
    const read = scannableRuns([
      { text: "Se", link: "/s?q=19811218%2525252D9876" },
    ]);

    expect(read.addresses.at(-1)).toBe("/s?q=19811218-9876");
    expect(read.unreadableAddress).toBe(false);
  });

  it("gives up on an address escaped more times than that, and says so", () => {
    // Each pass may take off one level only, so decoding this to the end
    // took a thousand passes and kept every reading: a few hundred such links
    // in one body held the process for seconds.
    const link = `%${"25".repeat(999)}2D`;

    const read = scannableRuns([{ text: "Se", link }]);

    expect(read.addresses.length).toBeLessThanOrEqual(5);
    expect(read.unreadableAddress).toBe(true);
  });

  it("holds one deep address against the runs beside readable ones", () => {
    expect(
      scannableRuns([
        { text: "Se", link: "/sida" },
        { text: " och", link: "/s?q=%25252525252D" },
      ]).unreadableAddress,
    ).toBe(true);
  });
});

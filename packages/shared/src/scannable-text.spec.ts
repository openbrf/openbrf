import { describe, expect, it } from "vitest";

import { scannableRunsText } from "./scannable-text.ts";

/**
 * The API refuses and the editor warns from this one reading, so what it
 * leaves out is left out of both.
 */
describe("scannableRunsText", () => {
  it("is the words alone when nothing links", () => {
    expect(scannableRunsText([{ text: "Hej " }, { text: "alla" }])).toBe(
      "Hej alla",
    );
  });

  it("reads each address after the words, apart from them", () => {
    expect(
      scannableRunsText([
        { text: "Skriv", link: "mailto:a@exempel.se?subject=19811218-9876" },
        { text: " till oss" },
      ]),
    ).toBe("Skriv till oss mailto:a@exempel.se?subject=19811218-9876");
  });

  it("reads an escaped address decoded as well as written", () => {
    expect(
      scannableRunsText([
        { text: "Skriv", link: "mailto:a@exempel.se?subject=19811218%2D9876" },
      ]),
    ).toBe(
      "Skriv mailto:a@exempel.se?subject=19811218%2D9876 mailto:a@exempel.se?subject=19811218-9876",
    );
  });

  it("reads an address that cannot be decoded as written", () => {
    expect(scannableRunsText([{ text: "Se", link: "/sida?rabatt=50%" }])).toBe(
      "Se /sida?rabatt=50%",
    );
  });
});

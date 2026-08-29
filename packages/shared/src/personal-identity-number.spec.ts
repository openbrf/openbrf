import { describe, expect, it } from "vitest";

import {
  isValidPersonalIdentityNumber,
  normalizePersonalIdentityNumber,
  parsePersonalIdentityNumber,
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

  it("finds nothing in an empty text", () => {
    expect(scanForPersonalIdentityNumbers("", REFERENCE)).toEqual([]);
  });

  it("does not carry a match from one scan into the next", () => {
    const text = "Ring Anna på 811228-9874.";

    expect(scanForPersonalIdentityNumbers(text, REFERENCE)).toHaveLength(1);
    expect(scanForPersonalIdentityNumbers(text, REFERENCE)).toHaveLength(1);
  });
});

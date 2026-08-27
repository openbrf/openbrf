import { describe, expect, it } from "vitest";

import {
  isValidPersonalIdentityNumber,
  normalizeEmail,
  normalizePersonalIdentityNumber,
  normalizePhone,
  parsePersonalIdentityNumber,
} from "./personal-data";

/**
 * These functions define the storage format of every blind index (ADR 0002),
 * so the cases below are a compatibility suite: a change that makes one fail
 * silently breaks search on existing data.
 */

// Fixed so century inference is deterministic rather than dependent on today.
const REFERENCE = new Date("2026-08-27T00:00:00Z");

describe("normalizeEmail", () => {
  it("trims and lowercases so one person yields one index", () => {
    expect(normalizeEmail("  Anna.Lindqvist@Exempel.SE  ")).toBe(
      "anna.lindqvist@exempel.se",
    );
  });

  it("maps every written casing of the same address onto one value", () => {
    const written = [
      "anna@exempel.se",
      "ANNA@EXEMPEL.SE",
      "Anna@Exempel.se",
      " anna@exempel.se ",
    ];
    const normalized = new Set(written.map(normalizeEmail));
    expect(normalized.size).toBe(1);
  });
});

describe("normalizePhone", () => {
  it.each([
    ["070-123 45 67", "+46701234567"],
    ["0701234567", "+46701234567"],
    ["+46 70 123 45 67", "+46701234567"],
    ["0046701234567", "+46701234567"],
    ["(070) 123 45 67", "+46701234567"],
    // A spreadsheet that dropped the leading zero.
    ["701234567", "+46701234567"],
  ])("maps the Swedish number %s onto %s", (input, expected) => {
    expect(normalizePhone(input)).toBe(expected);
  });

  it("collapses every Swedish spelling onto a single index value", () => {
    const written = [
      "070-123 45 67",
      "0701234567",
      "+46 70 123 45 67",
      "0046 70-1234567",
    ];
    expect(new Set(written.map(normalizePhone)).size).toBe(1);
  });

  it("keeps a non-Swedish country code instead of assuming Sweden", () => {
    expect(normalizePhone("+44 20 7123 4567")).toBe("+442071234567");
  });

  it("returns an empty string for input with no digits", () => {
    expect(normalizePhone("")).toBe("");
    expect(normalizePhone("   ")).toBe("");
    expect(normalizePhone("not a phone")).toBe("");
  });
});

describe("parsePersonalIdentityNumber", () => {
  it("resolves the century to the most recent year that is not in the future", () => {
    // 811228 cannot mean 2081, so it means 1981.
    expect(parsePersonalIdentityNumber("811228-9874", REFERENCE)?.year).toBe(
      1981,
    );
    // 121212 can mean 2012, which is in the past, so it does.
    expect(parsePersonalIdentityNumber("121212-1212", REFERENCE)?.year).toBe(
      2012,
    );
  });

  it("treats a plus separator as one century older", () => {
    expect(parsePersonalIdentityNumber("121212+1212", REFERENCE)?.year).toBe(
      1912,
    );
  });

  it("takes an explicitly written century at face value", () => {
    expect(parsePersonalIdentityNumber("19121212-1212", REFERENCE)?.year).toBe(
      1912,
    );
    expect(parsePersonalIdentityNumber("20121212-1212", REFERENCE)?.year).toBe(
      2012,
    );
  });

  it("flags a coordination number, where the day carries a +60 offset", () => {
    const parsed = parsePersonalIdentityNumber("121272-1219", REFERENCE);
    expect(parsed?.isCoordinationNumber).toBe(true);
    // The day is kept as written so the canonical form round-trips.
    expect(parsed?.day).toBe(72);
  });

  it("returns null for input that is not shaped like an identity number", () => {
    expect(parsePersonalIdentityNumber("", REFERENCE)).toBeNull();
    expect(parsePersonalIdentityNumber("not-a-number", REFERENCE)).toBeNull();
    expect(parsePersonalIdentityNumber("12121-1212", REFERENCE)).toBeNull();
    // Month 13 and day 45 are impossible.
    expect(parsePersonalIdentityNumber("121312-1212", REFERENCE)).toBeNull();
    expect(parsePersonalIdentityNumber("121245-1212", REFERENCE)).toBeNull();
  });
});

describe("normalizePersonalIdentityNumber", () => {
  it("produces twelve digits without a separator", () => {
    expect(normalizePersonalIdentityNumber("811228-9874", REFERENCE)).toBe(
      "198112289874",
    );
  });

  it("collapses every written form of one number onto a single index value", () => {
    const written = [
      "811228-9874",
      "8112289874",
      "19811228-9874",
      "198112289874",
      " 811228 - 9874 ",
    ];
    const normalized = new Set(
      written.map((value) => normalizePersonalIdentityNumber(value, REFERENCE)),
    );
    expect(normalized).toEqual(new Set(["198112289874"]));
  });

  it("returns null rather than an unmatchable index for bad input", () => {
    expect(normalizePersonalIdentityNumber("nonsense", REFERENCE)).toBeNull();
  });
});

describe("isValidPersonalIdentityNumber", () => {
  it.each([
    // Tolvan Tolvansson, the canonical Swedish test number.
    "121212-1212",
    "19121212-1212",
    "811228-9874",
    // Coordination number with a valid checksum.
    "121272-1219",
  ])("accepts %s", (value) => {
    expect(isValidPersonalIdentityNumber(value, REFERENCE)).toBe(true);
  });

  it.each([
    // Correct shape, wrong Luhn check digit.
    "121212-1213",
    "811228-9875",
  ])("rejects %s because the check digit is wrong", (value) => {
    expect(isValidPersonalIdentityNumber(value, REFERENCE)).toBe(false);
  });

  it("rejects input that is not an identity number at all", () => {
    expect(isValidPersonalIdentityNumber("", REFERENCE)).toBe(false);
    expect(isValidPersonalIdentityNumber("hello", REFERENCE)).toBe(false);
  });
});

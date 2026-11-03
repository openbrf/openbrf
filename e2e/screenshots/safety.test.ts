import { describe, expect, it } from "vite-plus/test";

import { findPhoneNumbers } from "./safety";

describe("findPhoneNumbers", () => {
  it("lets a generated id through that holds ten digits shaped like a number", () => {
    // An apartment id the access report printed in an audit entry's detail on
    // one run of the walk: a cuid, whose digits come from the clock.
    expect(
      findPhoneNumbers(
        "apartmentId: cmw0a0761000506r118hutuv1; kind: apartment",
      ),
    ).toEqual([]);
  });

  it("lets an id through wherever the digits fall in it, and in a line of text", () => {
    expect(findPhoneNumbers("id=cmw0a0761000506r118hutuv1.")).toEqual([]);
    expect(findPhoneNumbers("cm0701234567abcdefghijkl1 (apartment)")).toEqual(
      [],
    );
  });

  it.each([
    ["a label touching the number", "Mobil0701234567", "0701234567"],
    ["a letter after the number only", "0761000506r118hutuv1", "0761000506"],
    ["a letter before the number only", "cmw0a0761000506", "0761000506"],
    ["a full stop after a label", "Mobil0701234567.", "0701234567"],
    ["a separator inside letters", "abc070-123 45 67def", "070-123 45 67"],
    ["upper-case letters around it", "ABC0701234567DEF", "0701234567"],
    [
      "a capitalised label after an id-shaped run",
      "cabcdefghijklmn0701234567PRIVAT",
      "0701234567",
    ],
    [
      "a Swedish letter after an id-shaped run",
      "cabcdefghijklmn0701234567å",
      "0701234567",
    ],
    [
      "a Swedish letter before an id-shaped run",
      "äcabcdefghijklmn0701234567",
      "0701234567",
    ],
    [
      "a decomposed Swedish letter before an id-shaped run",
      "a\u0308cabcdefghijklmn0701234567",
      "0701234567",
    ],
    [
      "a letter outside the Basic Multilingual Plane before an id-shaped run",
      "\u{10400}cabcdefghijklmn0701234567",
      "0701234567",
    ],
    [
      "a line break between an id-shaped run and the number",
      "cabcdefghijklmn\n0701234567",
      "0701234567",
    ],
    ["a label on each side", "Mobil0701234567privat", "0701234567"],
    [
      "a token one character short of an id",
      "cmw0a0761000506r118hutuv",
      "0761000506",
    ],
    [
      "a token one character past an id",
      "cmw0a0761000506r118hutuv12",
      "0761000506",
    ],
    [
      "a token of an id's length not starting with c",
      "mmw0a0761000506r118hutuv1",
      "0761000506",
    ],
    [
      "an id's length with a capital in it",
      "cmw0a0761000506R118hutuv1",
      "0761000506",
    ],
    ["the written form", "Telefon 070-123 45 67", "070-123 45 67"],
    ["the international form", "+46 70 123 45 67", "+46 70 123 45 67"],
  ])("still finds a number with %s", (_description, text, found) => {
    expect(findPhoneNumbers(text)).toEqual([found]);
  });

  describe("after a long run of letters", () => {
    // Long enough that reading the whole text before each number, as the
    // guard once did, takes several times the test's timeout. No wall-clock
    // assertion of its own: the guard reads a few dozen characters around a
    // number however long the page is.
    const run = "a".repeat(200_000);

    it("finds a number after a space", () => {
      expect(findPhoneNumbers(`${run} 0701234567`)).toEqual(["0701234567"]);
    });

    it("finds a number the run touches", () => {
      expect(findPhoneNumbers(`${run}cabcdefghijklmn0701234567`)).toEqual([
        "0701234567",
      ]);
    });

    it("lets an id through after a space", () => {
      expect(findPhoneNumbers(`${run} cmw0a0761000506r118hutuv1`)).toEqual([]);
    });
  });

  it("finds a number after a run of letters outside the Basic Multilingual Plane", () => {
    // Twenty such letters are forty UTF-16 code units, so the window of
    // twenty-five the guard reads before the number starts inside a pair.
    expect(findPhoneNumbers(`${"\u{10400}".repeat(20)}0701234567`)).toEqual([
      "0701234567",
    ]);
  });

  it("lets a date, a time and an amount through", () => {
    expect(
      findPhoneNumbers("2026-07-01 – 2026-07-31, kl. 07:30, 1 070 123,45 kr"),
    ).toEqual([]);
  });
});

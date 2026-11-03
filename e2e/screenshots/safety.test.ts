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

  it.each([
    ["a label touching the number", "Mobil0701234567", "0701234567"],
    ["a letter after the number only", "0761000506r118hutuv1", "0761000506"],
    ["a letter before the number only", "cmw0a0761000506", "0761000506"],
    ["a full stop after a label", "Mobil0701234567.", "0701234567"],
    ["a separator inside letters", "abc070-123 45 67def", "070-123 45 67"],
    ["upper-case letters around it", "ABC0701234567DEF", "0701234567"],
    ["the written form", "Telefon 070-123 45 67", "070-123 45 67"],
    ["the international form", "+46 70 123 45 67", "+46 70 123 45 67"],
  ])("still finds a number with %s", (_description, text, found) => {
    expect(findPhoneNumbers(text)).toEqual([found]);
  });

  it("lets a date, a time and an amount through", () => {
    expect(
      findPhoneNumbers("2026-07-01 – 2026-07-31, kl. 07:30, 1 070 123,45 kr"),
    ).toEqual([]);
  });
});

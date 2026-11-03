import { describe, expect, it } from "vite-plus/test";

import { findDoorCode, latestFindingTargetDate } from "./issue-fit.ts";

describe("findDoorCode", () => {
  it.each([
    "Portkod 1234",
    "Koden är 4821",
    "Porten har koden 12 34",
    "door code: 9087",
    "The gate code is A1234",
    "PIN 0000",
    "Lösenord: hej123",
    "Nyckelkod 1-2-3-4",
    "Ring på, och koden till porten är *5821#",
    "1234",
    "Ta in 123456 i panelen",
    // The same codes written so a pattern that reads them literally misses
    // them: a zero-width space inside the digits, and full-width digits.
    "Koden är 48\u200b21",
    "Porten: 4\u200d8\u200d2\u200d1",
    "Koden är ４８２１",
  ])("refuses %j", (text) => {
    expect(findDoorCode(text)).not.toBeNull();
  });

  it("says where the code starts, and nothing of its value", () => {
    const text = "Ring på, portkod 1234.";
    const match = findDoorCode(text);
    expect(match).toEqual({ offset: text.indexOf("portkod") });
    expect(Object.keys(match ?? {})).toEqual(["offset"]);
  });

  it.each([
    "Jag är hemma efter 17, ring på.",
    "Hunden är snäll men skäller.",
    "Ring 070-123 45 67 om ingen öppnar",
    "Ring 08-123 456 78",
    "Jag är hemma 14.30 till 16.30",
    "Mellan 14:30 och 16:00",
    "Hissen mellan våning 3 och 4",
    "Kom den 12 maj 2026",
    "Lgh 1101 har läckan",
    "Lägenhet 1203, ring på",
    "Koden finns hos grannen. Ring 112 vid brand.",
    "Barkoden sitter på kartongen",
    "Kodspråket är svenska",
  ])("lets %j through", (text) => {
    expect(findDoorCode(text)).toBeNull();
  });

  it("reports where the code starts in the text as written, invisible characters counted", () => {
    const text = "Ring på\u200b, portkod 1234.";
    expect(findDoorCode(text)).toEqual({ offset: text.indexOf("portkod") });
    const digits = "Ta\u200b in 1234";
    expect(findDoorCode(digits)).toEqual({ offset: digits.indexOf("1234") });
  });

  it("reads a four-digit year without a month as a possible code", () => {
    expect(findDoorCode("Kommer 2026")).not.toBeNull();
  });
});

describe("latestFindingTargetDate", () => {
  it("gives a lift finding one month from the inspection", () => {
    expect(latestFindingTargetDate("LIFT", "2026-03-15")).toBe("2026-04-15");
    expect(latestFindingTargetDate("LIFT", "2026-12-20")).toBe("2027-01-20");
  });

  it("lands on the last day of a shorter month", () => {
    expect(latestFindingTargetDate("LIFT", "2026-01-31")).toBe("2026-02-28");
    expect(latestFindingTargetDate("LIFT", "2028-01-31")).toBe("2028-02-29");
    expect(latestFindingTargetDate("LIFT", "2026-03-31")).toBe("2026-04-30");
  });

  it("sets none for an inspection the law gives no date for", () => {
    expect(latestFindingTargetDate("OVK", "2026-03-15")).toBeNull();
    expect(latestFindingTargetDate("FIRE", "2026-03-15")).toBeNull();
  });

  it("sets none for something that is not a day", () => {
    expect(latestFindingTargetDate("LIFT", "soon")).toBeNull();
  });
});

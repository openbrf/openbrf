import { describe, expect, it } from "vitest";

import {
  apartmentNumberFor,
  ApartmentNumberingError,
  floorOfApartmentNumber,
  generateApartmentNumbers,
  HIGHEST_FLOOR,
  LOWEST_FLOOR,
} from "./apartment-numbering.ts";

describe("apartmentNumberFor", () => {
  it("numbers the entrance floor 10XX", () => {
    expect(apartmentNumberFor(0, 1)).toBe("1001");
    expect(apartmentNumberFor(0, 12)).toBe("1012");
  });

  it("counts floors upwards from the entrance", () => {
    expect(apartmentNumberFor(1, 1)).toBe("1101");
    expect(apartmentNumberFor(2, 3)).toBe("1203");
  });

  it("keeps four digits for floors below the entrance", () => {
    // A basement apartment is 09XX, and the leading zero is part of the
    // designation: dropping it would misalign the mono register column.
    expect(apartmentNumberFor(-1, 1)).toBe("0901");
    expect(apartmentNumberFor(-1, 1)).toHaveLength(4);
  });

  it("refuses a floor the four-digit form cannot express", () => {
    expect(() => apartmentNumberFor(LOWEST_FLOOR - 1, 1)).toThrow(
      ApartmentNumberingError,
    );
    expect(() => apartmentNumberFor(HIGHEST_FLOOR + 1, 1)).toThrow(
      ApartmentNumberingError,
    );
  });

  it("refuses more apartments than a landing's two digits hold", () => {
    expect(apartmentNumberFor(0, 99)).toBe("1099");
    expect(() => apartmentNumberFor(0, 100)).toThrow(ApartmentNumberingError);
    expect(() => apartmentNumberFor(0, 0)).toThrow(ApartmentNumberingError);
  });

  it("refuses a fractional floor or index rather than rounding it", () => {
    expect(() => apartmentNumberFor(1.5, 1)).toThrow(ApartmentNumberingError);
    expect(() => apartmentNumberFor(1, 1.5)).toThrow(ApartmentNumberingError);
  });
});

describe("floorOfApartmentNumber", () => {
  it("reads the floor back out of a conventional number", () => {
    expect(floorOfApartmentNumber("1001")).toBe(0);
    expect(floorOfApartmentNumber("1101")).toBe(1);
    expect(floorOfApartmentNumber("1203")).toBe(2);
    expect(floorOfApartmentNumber("0901")).toBe(-1);
  });

  it("round-trips every floor the form can express", () => {
    for (let floor = LOWEST_FLOOR; floor <= HIGHEST_FLOOR; floor++) {
      expect(floorOfApartmentNumber(apartmentNumberFor(floor, 1))).toBe(floor);
    }
  });

  it("returns null for a number that does not follow the convention", () => {
    // An association is entitled to number its apartments 1, 2, 3. Guessing a
    // floor for those would file them under a grouping that does not exist.
    expect(floorOfApartmentNumber("1")).toBeNull();
    expect(floorOfApartmentNumber("12A")).toBeNull();
    expect(floorOfApartmentNumber("11011")).toBeNull();
    expect(floorOfApartmentNumber("")).toBeNull();
  });
});

describe("generateApartmentNumbers", () => {
  it("produces the plan's example range for three floors of three", () => {
    const rows = generateApartmentNumbers({
      lowestFloor: 0,
      floorCount: 3,
      apartmentsPerFloor: 3,
    });

    expect(rows.map((row) => row.number)).toEqual([
      "1001",
      "1002",
      "1003",
      "1101",
      "1102",
      "1103",
      "1201",
      "1202",
      "1203",
    ]);
  });

  it("carries the floor alongside each number", () => {
    const rows = generateApartmentNumbers({
      lowestFloor: 1,
      floorCount: 2,
      apartmentsPerFloor: 1,
    });

    expect(rows).toEqual([
      { number: "1101", floor: 1 },
      { number: "1201", floor: 2 },
    ]);
  });

  it("starts below the entrance when asked", () => {
    const rows = generateApartmentNumbers({
      lowestFloor: -1,
      floorCount: 2,
      apartmentsPerFloor: 2,
    });

    expect(rows.map((row) => row.number)).toEqual([
      "0901",
      "0902",
      "1001",
      "1002",
    ]);
  });

  it("generates nothing rather than failing for an empty building", () => {
    expect(
      generateApartmentNumbers({
        lowestFloor: 0,
        floorCount: 0,
        apartmentsPerFloor: 10,
      }),
    ).toEqual([]);
  });

  it("refuses a negative floor count", () => {
    expect(() =>
      generateApartmentNumbers({
        lowestFloor: 0,
        floorCount: -1,
        apartmentsPerFloor: 1,
      }),
    ).toThrow(ApartmentNumberingError);
  });

  it("refuses to run off the top of the four-digit form", () => {
    expect(() =>
      generateApartmentNumbers({
        lowestFloor: HIGHEST_FLOOR,
        floorCount: 2,
        apartmentsPerFloor: 1,
      }),
    ).toThrow(ApartmentNumberingError);
  });
});

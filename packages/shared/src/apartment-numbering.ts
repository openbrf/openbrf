/**
 * Apartment numbering, Lantmateriet style.
 *
 * A Swedish apartment number is four digits: the first two are the floor and
 * the last two number the apartments on that landing from 01. The entrance
 * floor is 10, so the ground floor reads 10XX, the first floor above it 11XX,
 * and a floor below the entrance counts down (09XX, 08XX). That is why the
 * numbers look like an offset rather than a plain floor number, and why the
 * address book groups rows as "Entreplan 10XX", "Plan 1 11XX".
 *
 * This lives in the shared package because both sides need the same numbers
 * from the same rule: the setup wizard generates and lets the board edit a
 * table in the browser, and the API derives the stored floor from whatever
 * number finally arrives. Two implementations would eventually disagree, and
 * the disagreement would show up as apartments filed under the wrong floor in
 * a statutory register.
 */

/** Floor prefix of the entrance floor. Floors above add 1, below subtract 1. */
export const ENTRANCE_FLOOR_PREFIX = 10;

/** Apartments that fit on one landing, given two digits starting at 01. */
export const MAX_APARTMENTS_PER_FLOOR = 99;

/**
 * Floors the four-digit form can express: prefix 00 to 99, which is 10 floors
 * below the entrance and 89 above it.
 */
export const LOWEST_FLOOR = -ENTRANCE_FLOOR_PREFIX;
export const HIGHEST_FLOOR = 99 - ENTRANCE_FLOOR_PREFIX;

export class ApartmentNumberingError extends Error {
  constructor(
    message: string,
    readonly reason: "floor-out-of-range" | "index-out-of-range",
  ) {
    super(message);
    this.name = "ApartmentNumberingError";
  }
}

/** One generated row, before the board edits it. */
export interface ApartmentNumberRow {
  /** Four digits, e.g. "1101". Always rendered in the mono face. */
  number: string;
  floor: number;
}

export interface GenerateApartmentNumbersInput {
  /** Floor to start from. 0 is the entrance floor; negatives go below it. */
  lowestFloor: number;
  /** How many floors to generate, counting upwards from lowestFloor. */
  floorCount: number;
  apartmentsPerFloor: number;
}

/**
 * The apartment number for one apartment on one floor.
 *
 * Padded to four digits so a basement apartment reads "0901" rather than
 * "901": the leading zero is part of the designation, and a register column of
 * mono digits only aligns if every entry is the same width.
 */
export function apartmentNumberFor(floor: number, index: number): string {
  if (
    !Number.isInteger(floor) ||
    floor < LOWEST_FLOOR ||
    floor > HIGHEST_FLOOR
  ) {
    throw new ApartmentNumberingError(
      `Floor ${floor} cannot be expressed as a four-digit apartment number.`,
      "floor-out-of-range",
    );
  }
  if (
    !Number.isInteger(index) ||
    index < 1 ||
    index > MAX_APARTMENTS_PER_FLOOR
  ) {
    throw new ApartmentNumberingError(
      `Apartment ${index} is outside the two digits a landing has.`,
      "index-out-of-range",
    );
  }

  return String((ENTRANCE_FLOOR_PREFIX + floor) * 100 + index).padStart(4, "0");
}

/**
 * The floor a number belongs to, or null when the number does not follow the
 * convention.
 *
 * Null rather than a guess: an association that numbers its apartments some
 * other way (1, 2, 3, or "12A") is entitled to, and inventing a floor for
 * those would file them under a physical grouping that does not exist. The
 * caller stores null and the board shows them ungrouped.
 */
export function floorOfApartmentNumber(number: string): number | null {
  if (!/^\d{4}$/.test(number)) {
    return null;
  }
  return Number(number.slice(0, 2)) - ENTRANCE_FLOOR_PREFIX;
}

/**
 * Generates the numbers for a rectangular building: so many floors, so many
 * apartments on each.
 *
 * The result is a starting point the board edits before anything is written,
 * which is what makes a generator acceptable for a statutory register at all:
 * no real building is perfectly rectangular, and the wizard commits the table
 * rather than the formula.
 */
export function generateApartmentNumbers(
  input: GenerateApartmentNumbersInput,
): ApartmentNumberRow[] {
  const rows: ApartmentNumberRow[] = [];

  if (input.floorCount < 0) {
    throw new ApartmentNumberingError(
      `A building cannot have ${input.floorCount} floors.`,
      "floor-out-of-range",
    );
  }

  for (let offset = 0; offset < input.floorCount; offset++) {
    const floor = input.lowestFloor + offset;
    for (let index = 1; index <= input.apartmentsPerFloor; index++) {
      rows.push({ number: apartmentNumberFor(floor, index), floor });
    }
  }

  return rows;
}

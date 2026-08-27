/**
 * Floor grouping, the way a physical porttavla is organised.
 *
 * The board groups its rows by floor and labels each group with the Lantmateriet
 * number range it covers ("Entreplan 10XX", "Plan 1 11XX"), because that is how
 * a resident reads the name board in their own stairwell: they look for the
 * floor first and the name second.
 *
 * Pure, and separate from the component, because the interesting cases are data
 * cases - a person with no apartment, two addresses whose ground floors both
 * number 10XX, a number that does not follow the convention - and each of them
 * should be provable without rendering anything.
 */

import type { DirectoryRow } from "./register-api";

export interface FloorGroup<TRow extends DirectoryRow> {
  /** Stable key for React, unique within the page. */
  key: string;
  /** Null for the trailing group of persons who hold no apartment. */
  floor: number | null;
  /**
   * The number range the group covers, e.g. "10XX". Null when the apartment
   * numbers in the group do not share a prefix, which happens with numbering
   * that does not follow the convention.
   */
  numberPrefix: string | null;
  /** The address these rows belong to; null for the no-apartment group. */
  addressId: string | null;
  /**
   * Whether the group header should name its address. True only when several
   * addresses are on screen at once, where "Entreplan 10XX" would otherwise
   * appear twice with nothing to tell the two stairwells apart.
   */
  showAddress: boolean;
  rows: TRow[];
}

/**
 * The floor a row belongs to.
 *
 * The stored floor wins; the apartment number is the fallback. Both exist
 * because the number is the convention and the stored value is the truth: a
 * cooperative whose numbering predates Lantmateriet's scheme still has floors.
 */
function floorOf(row: DirectoryRow): number | null {
  if (row.apartment === null) {
    return null;
  }
  if (row.apartment.floor !== null) {
    return row.apartment.floor;
  }
  // "1101" -> floor 1. Four digits, the first being the building's own digit.
  const parsed = Number.parseInt(row.apartment.number.slice(1, 2), 10);
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * The "10XX" style prefix shared by a group's apartment numbers, or null when
 * they do not share one.
 */
function numberPrefixOf(rows: readonly DirectoryRow[]): string | null {
  const prefixes = new Set(
    rows
      .map((row) => row.apartment?.number.slice(0, 2))
      .filter((prefix): prefix is string => prefix !== undefined),
  );
  const [only] = [...prefixes];
  return prefixes.size === 1 && only !== undefined ? `${only}XX` : null;
}

/**
 * Groups rows into floor groups, preserving the server's order.
 *
 * The server orders by address and then apartment number, so grouping runs of
 * consecutive rows is enough and no sorting happens here: re-sorting on the
 * client would silently disagree with the pagination the server applied.
 *
 * Rows with no apartment - external board members, and anyone entered but not
 * yet moved in - cannot sit on a floor, so they collect into one trailing group.
 */
export function groupByFloor<TRow extends DirectoryRow>(
  rows: readonly TRow[],
  options: { multipleAddresses: boolean },
): FloorGroup<TRow>[] {
  const groups: FloorGroup<TRow>[] = [];
  const withoutApartment: TRow[] = [];

  for (const row of rows) {
    if (row.apartment === null) {
      withoutApartment.push(row);
      continue;
    }

    const floor = floorOf(row);
    const addressId = row.apartment.addressId;
    const last = groups.at(-1);

    if (
      last !== undefined &&
      last.floor === floor &&
      last.addressId === addressId
    ) {
      last.rows.push(row);
      continue;
    }

    groups.push({
      key: `${addressId}:${String(floor)}`,
      floor,
      numberPrefix: null,
      addressId,
      showAddress: options.multipleAddresses,
      rows: [row],
    });
  }

  for (const group of groups) {
    group.numberPrefix = numberPrefixOf(group.rows);
  }

  if (withoutApartment.length > 0) {
    groups.push({
      key: "without-apartment",
      floor: null,
      numberPrefix: null,
      addressId: null,
      showAddress: false,
      rows: withoutApartment,
    });
  }

  return groups;
}

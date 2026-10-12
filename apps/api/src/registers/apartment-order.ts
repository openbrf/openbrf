import type { Prisma } from "../generated/prisma/client";

/**
 * The order the registers list apartments in: entrance by entrance, the way
 * the address book sorts its entrances, and by apartment number within one.
 *
 * Street and number after the entrance's own position because that position
 * defaults to 0 and two entrances can share it, which left their apartments
 * interleaved by number and two flats numbered 1101 in no fixed order. An
 * address is unique on its street and number, and an apartment on its address
 * and number, so this order is total.
 */
export const APARTMENT_REGISTER_ORDER = [
  { address: { sortOrder: "asc" } },
  { address: { street: "asc" } },
  { address: { number: "asc" } },
  { number: "asc" },
] as const satisfies Prisma.ApartmentOrderByWithRelationInput[];

/**
 * The address book view model, and the masking rules that produce it.
 *
 * This file is the whole of the masking matrix from plan section 4.4, written
 * as pure functions over a record read from the database. It is pure on
 * purpose: masking is the highest-stakes behaviour in the product, and a rule
 * that needs a request, a session and a database to exercise is a rule nobody
 * tests exhaustively.
 *
 * The matrix, in short:
 *
 *   Data                  Board / admin              Other residents
 *   Name, apartment, role Visible                    Visible
 *   Email, phone          Visible                    Never - the column is
 *                                                    absent, not masked
 *   Personal identity nr  Reveal action only, logged  Never
 *   Protected person      Masked, per-field reveal   Not listed at all
 *
 * Two things follow from that and are load-bearing:
 *
 *  1. The resident-facing row type has no place to put contact data. Residents
 *     do not receive a masked or empty contact field; they receive a row that
 *     cannot carry one. The service reinforces this by not even selecting the
 *     cipher columns for that audience, so a mapping mistake cannot leak what
 *     was never loaded.
 *  2. A personal identity number never appears in any list row, masked or not,
 *     for any audience. The only way to see one is the audited reveal, on the
 *     person view. DESIGN.md forbids it outside the register views, and a list
 *     is the easiest place for it to end up in a screenshot or an export.
 *
 * Swedish domain terms follow GLOSSARY.md: the address book is not the member
 * register (medlemsforteckning) and not the apartment register
 * (lagenhetsforteckning). Those are separate statutory documents with their own
 * views; nothing here is an extract from either.
 */

import type {
  BoardPositionType,
  ResidencyRole,
} from "../generated/prisma/enums";

/**
 * Who is looking.
 *
 * "board" is the board and admin view, which carries contact data. "resident"
 * is every other signed-in person. The property manager is deliberately
 * neither: that role never reaches the address book at all, which the
 * capability layer enforces before anything here runs.
 */
export type AddressBookAudience = "board" | "resident";

/**
 * A sign on a row (skylt-chip in DESIGN.md).
 *
 * The API returns the sign, never its Swedish or English wording: the label is
 * an i18n key on the client. Order matters and is fixed by
 * {@link signsFor}, so two rows never list the same signs in a different
 * order.
 */
export type AddressBookSign =
  | "CHAIR"
  | "BOARD_MEMBER"
  | "DEPUTY_BOARD_MEMBER"
  | "MEMBER"
  | "RESIDENT"
  | "PROTECTED"
  | "MOVED_OUT";

/** The apartment a row sits on, or null for a person without one. */
export interface AddressBookApartment {
  id: string;
  addressId: string;
  /** Lantmateriet numbering, e.g. "1101". Rendered on the mono grid. */
  number: string;
  /** Floor, used for the physical grouping on the board. */
  floor: number | null;
}

/**
 * Contact data on a board row.
 *
 * The masked variant reports only *whether* a value exists, which is what the
 * board needs in order to know a reveal is worth requesting. The values
 * themselves are not in this object, so they are not in the response either.
 */
export type AddressBookContact =
  | { state: "visible"; email: string | null; phone: string | null }
  | { state: "masked"; hasEmail: boolean; hasPhone: boolean };

/**
 * A row as residents see it: names, apartments, roles and dates.
 *
 * No contact data and no purge date. The purge date is service-tier
 * housekeeping the board acts on, not something a neighbour needs.
 */
export interface ResidentDirectoryRow {
  /** Stable key: one person can hold several residencies. */
  key: string;
  personId: string;
  name: string;
  apartment: AddressBookApartment | null;
  signs: AddressBookSign[];
  movedInOn: string | null;
  movedOutOn: string | null;
}

/** A row as the board and admins see it. */
export interface AddressBookRow extends ResidentDirectoryRow {
  contact: AddressBookContact;
  /**
   * Date the service-tier data is erased, derived from the retention policy.
   * Null while the residency is current. The statutory member register entry is
   * exempt and is never erased on this date.
   */
  purgeOn: string | null;
  protectedPersonalData: boolean;
}

/**
 * What the database layer hands the mapper.
 *
 * `email` and `phone` are already decrypted, or null when the audience is not
 * entitled to them, when the person has none, or when the person carries
 * protected personal data - in that last case the service does not decrypt at
 * all, so the plaintext never exists in the process.
 */
export interface AddressBookRecord {
  personId: string;
  /** Null for a person with no residency: an external board member or admin. */
  residencyId: string | null;
  firstName: string;
  lastName: string;
  protectedPersonalData: boolean;
  apartment: AddressBookApartment | null;
  role: ResidencyRole | null;
  movedInOn: Date | null;
  movedOutOn: Date | null;
  /** Active positions of trust, driving the brass signs. */
  boardPositions: readonly BoardPositionType[];
  email: string | null;
  phone: string | null;
  /** Whether an encrypted value is stored, known without decrypting it. */
  hasEmail: boolean;
  hasPhone: boolean;
}

/** Fields that a person with protected personal data has masked. */
export const MASKABLE_FIELDS = [
  "email",
  "phone",
  "personalIdentityNumber",
  "postalAddress",
] as const;

export type MaskableField = (typeof MASKABLE_FIELDS)[number];

/**
 * The personal identity number is masked for everyone, always, protected flag
 * or not: the board reaches it only through the audited reveal. Keeping it in
 * this list rather than special-casing it at the call site means a new caller
 * cannot forget.
 */
export const ALWAYS_MASKED_FIELDS: readonly MaskableField[] = [
  "personalIdentityNumber",
];

/**
 * Whether a field is masked for this person.
 *
 * Protected personal data (skyddade personuppgifter) masks contact details and
 * the postal address, because the postal address is precisely what protection
 * exists to withhold. The alternative address, when the association has one on
 * file, is what may be shown in its place.
 */
export function isMasked(
  field: MaskableField,
  person: { protectedPersonalData: boolean },
): boolean {
  if (ALWAYS_MASKED_FIELDS.includes(field)) {
    return true;
  }
  return person.protectedPersonalData;
}

/**
 * Whether a row belongs in the resident-facing directory.
 *
 * A person with protected personal data is excluded from resident-facing lists
 * entirely (4.4) - not masked, not greyed out, absent. The single exception is
 * the viewer themselves: a protected resident opening the directory sees their
 * own entry, which discloses nothing to anyone, and hiding it would read as the
 * register having lost them.
 */
export function isVisibleToResidents(
  person: { personId: string; protectedPersonalData: boolean },
  viewerPersonId: string,
): boolean {
  return !person.protectedPersonalData || person.personId === viewerPersonId;
}

/**
 * The signs on a row, in a fixed order: trust first, then the register role,
 * then the states.
 *
 * Every sign is a label, never a colour on its own: the client pairs each with
 * text, and the protected and moved-out signs additionally carry a lock icon
 * and a dashed outline. DESIGN.md requires the second signal, and a board
 * member with red-green colour blindness requires it in practice.
 */
export function signsFor(
  record: Pick<
    AddressBookRecord,
    "boardPositions" | "role" | "protectedPersonalData" | "movedOutOn"
  >,
  today: Date,
): AddressBookSign[] {
  const signs: AddressBookSign[] = [];

  // Trust roles in the order of seniority, not of the enum.
  for (const position of [
    "CHAIR",
    "BOARD_MEMBER",
    "DEPUTY_BOARD_MEMBER",
  ] as const) {
    if (record.boardPositions.includes(position)) {
      signs.push(position);
    }
  }

  if (record.role !== null) {
    signs.push(record.role);
  }
  if (record.protectedPersonalData) {
    signs.push("PROTECTED");
  }
  if (hasMovedOut(record.movedOutOn, today)) {
    signs.push("MOVED_OUT");
  }

  return signs;
}

/**
 * Whether a residency has ended.
 *
 * A move-out date in the future is a scheduled move-out, and the person is
 * still resident until it arrives. This matches how PrincipalService decides
 * which residencies still grant access, and the two must agree: a row shown as
 * moved out while the account still has resident access would be a lie in
 * whichever direction the reader trusted.
 */
export function hasMovedOut(
  movedOutOn: Date | null,
  today: Date,
): movedOutOn is Date {
  return movedOutOn !== null && movedOutOn.getTime() <= today.getTime();
}

/** ISO calendar date (YYYY-MM-DD), which is what the mono grid renders. */
export function toIsoDate(value: Date | null): string | null {
  if (value === null) {
    return null;
  }
  const iso = value.toISOString();
  return iso.slice(0, iso.indexOf("T"));
}

function fullName(record: Pick<AddressBookRecord, "firstName" | "lastName">) {
  return `${record.firstName} ${record.lastName}`.trim();
}

function rowKey(record: AddressBookRecord): string {
  // A person with two residencies produces two rows, so the residency has to be
  // part of the key or React would reuse one row's state for the other.
  return record.residencyId ?? `person:${record.personId}`;
}

/**
 * Maps a record to a board row.
 *
 * @param purgeOn Already computed by the caller, which holds the association's
 *   retention policy. Passed in rather than looked up so this stays pure.
 */
export function toAddressBookRow(
  record: AddressBookRecord,
  options: { today: Date; purgeOn: string | null },
): AddressBookRow {
  return {
    key: rowKey(record),
    personId: record.personId,
    name: fullName(record),
    apartment: record.apartment,
    signs: signsFor(record, options.today),
    movedInOn: toIsoDate(record.movedInOn),
    movedOutOn: toIsoDate(record.movedOutOn),
    protectedPersonalData: record.protectedPersonalData,
    contact: record.protectedPersonalData
      ? {
          state: "masked",
          hasEmail: record.hasEmail,
          hasPhone: record.hasPhone,
        }
      : { state: "visible", email: record.email, phone: record.phone },
    purgeOn: options.purgeOn,
  };
}

/**
 * Maps a record to a resident-facing row.
 *
 * Written as a fresh object literal rather than by removing keys from a board
 * row, so contact data has no path into it even if the record carries some.
 */
export function toResidentDirectoryRow(
  record: AddressBookRecord,
  options: { today: Date },
): ResidentDirectoryRow {
  return {
    key: rowKey(record),
    personId: record.personId,
    name: fullName(record),
    apartment: record.apartment,
    signs: signsFor(record, options.today),
    movedInOn: toIsoDate(record.movedInOn),
    movedOutOn: toIsoDate(record.movedOutOn),
  };
}

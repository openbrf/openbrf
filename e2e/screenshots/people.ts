import { ADDRESSES } from "../src/provision";

/**
 * Everybody the capture invents, and the one rule all of them obey.
 *
 * The images go into pull requests on a public repository about a statutory
 * personal-data register, so anything a capture can photograph is published.
 * Nobody here carries a personal identity number or a phone number, and every
 * address is on `.test`, the top-level domain RFC 2606 reserves so that nothing
 * can resolve. `screenshots/safety.ts` refuses an image that breaks either rule
 * before the file is written; this file is where the rule is kept rather than
 * caught.
 *
 * Held apart from `screens.ts` because the walk and the capture both need these
 * names: an entry waits for a person to appear in a register the capture put
 * them in, and a name written twice is a name that drifts.
 */

const [STORGATAN_12] = ADDRESSES;

/** "Storgatan 12", the way an address reads on screen and in a document. */
const STORGATAN_12_LABEL = `${STORGATAN_12.street} ${STORGATAN_12.number}`;

/**
 * The resident whose session the resident-facing board is captured from.
 *
 * One of the four people the shared register fixture seeds, given an account
 * through the invitation flow like any other. The password is a fixture value
 * on a throwaway instance that is destroyed when the run ends.
 */
export const RESIDENT = {
  name: "Nils Lindqvist",
  email: "nils@eksemplet.test",
  password: "granngarden-kastanj-2026",
} as const;

/**
 * A tenant-owner, moved in with her transfer.
 *
 * The shared fixture puts its four people on apartments through sign-up
 * approval, which records a residency and nothing statutory. The member
 * register is written by a move-in, and the apartment register states who holds
 * an apartment, so without somebody who moved in as a member both statutory
 * documents would be photographed empty. She is also the one persona who can
 * open her own entry in the apartment register: that screen exists for a
 * tenant-owner, and the resident above holds no tenant-ownership.
 */
export const MEMBER = {
  firstName: "Elin",
  lastName: "Hammar",
  name: "Elin Hammar",
  email: "elin@eksemplet.test",
  password: "vinterljus-kastanjeblad-2026",
  addressNumber: STORGATAN_12.number,
  apartmentNumber: "1201",
  /** As both registers print it. */
  designation: `${STORGATAN_12_LABEL} 1201`,
  heldFrom: "2024-09-01",
  price: "2150000",
  agreementReference: "OVL-2024-1201",
  postalStreet: STORGATAN_12_LABEL,
  postalCode: STORGATAN_12.postalCode,
  postalCity: STORGATAN_12.city,
} as const;

/**
 * The visitor who fills in the public request-an-account form.
 *
 * Her request is left waiting rather than decided, because the board's queue is
 * photographed with it in: an empty queue is a different screen from the one a
 * board actually meets.
 */
export const APPLICANT = {
  firstName: "Vera",
  lastName: "Sandell",
  email: "vera@eksemplet.test",
  claimedAddress: STORGATAN_12_LABEL,
  claimedApartmentNumber: "1203",
} as const;

/**
 * The member list the import screens are photographed reading.
 *
 * Three rows, on apartments the fixture leaves empty, so every row previews as
 * a new person and the mapping step has a column for each field the guess is
 * worth showing - including one the register wants nothing from. It carries no
 * personal identity number: the preview reports that a file holds one without
 * showing it, but the mapping step lists a column's first values, and a number
 * would be painted there.
 *
 * The walk stops at the preview and never applies it, so nothing in this list
 * reaches the register.
 */
const MEMBER_LIST_ROWS = [
  [
    "Adress",
    "Lägenhetsnummer",
    "Förnamn",
    "Efternamn",
    "Roll",
    "E-postadress",
    "Inflyttningsdatum",
    "Anteckning",
  ],
  [
    STORGATAN_12_LABEL,
    "1301",
    "Majken",
    "Ohlsson",
    "Medlem",
    "majken@eksemplet.test",
    "2019-04-01",
    "Överförd från pärmen",
  ],
  [
    STORGATAN_12_LABEL,
    "1302",
    "Torsten",
    "Ohlsson",
    "Boende",
    "torsten@eksemplet.test",
    "2019-04-01",
    "Överförd från pärmen",
  ],
  [
    `${ADDRESSES[1].street} ${ADDRESSES[1].number}`,
    "1101",
    "Ester",
    "Lundgren",
    "Medlem",
    "ester@eksemplet.test",
    "2021-08-15",
    "Överförd från pärmen",
  ],
] as const;

export const MEMBER_LIST = {
  fileName: "medlemslista.csv",
  mimeType: "text/csv",
  // Semicolons, because a Swedish spreadsheet writes them and the parser tries
  // that separator first.
  text: MEMBER_LIST_ROWS.map((row) => row.join(";")).join("\n"),
} as const;

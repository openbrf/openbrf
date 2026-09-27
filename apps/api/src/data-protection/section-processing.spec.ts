import { describe, expect, it } from "vitest";

import { SEED_KEYS, type SeedKey } from "./processing-activity-seed";
import {
  REPORTED_SECTIONS,
  SECTION_PROCESSING,
  type ReportSection,
  type SectionProcessing,
} from "./section-processing";

/**
 * That every section of the data subject access report names the processing
 * in the record that covers it, as a test.
 *
 * The compiler holds the first half: `satisfies` fails for a key of the report
 * with no entry, and for an entry naming a row that is not a seed key. What it
 * cannot hold is below - which keys may name no row at all, and which rows no
 * section reaches - because a map where every new section could be declared
 * part of the document, or a record row nobody's data reaches, would pass the
 * compiler and describe nothing.
 */

const ENTRIES = Object.entries(SECTION_PROCESSING) as [
  ReportSection,
  SectionProcessing,
][];

/**
 * The rows no section of the access report reaches, and why.
 *
 * "viewOfAnotherRow": the processing shows data another row holds, and that
 *   row's sections carry it.
 * "notKeyedToAPerson": the table names nobody the register holds, so there is
 *   no person whose report it could be on.
 * "notOnTheReport": the table is keyed to a person and the access report does
 *   not carry it - a gap in the report, named here rather than hidden, and not
 *   something this map can close.
 *
 * Checked in both directions, for the reason `erasure-domains.spec.ts` gives
 * about its own list: an entry nothing uses is inherited by the next edit
 * without anybody deciding to keep it.
 */
const ROWS_WITHOUT_A_SECTION: Partial<
  Record<SeedKey, "viewOfAnotherRow" | "notKeyedToAPerson" | "notOnTheReport">
> = {
  // Who lives in the building, read from the address book, whose data is on
  // `person` and `residencies`.
  residentDirectory: "viewOfAnotherRow",
  // A contact submission has no person column at all.
  contactSubmissions: "notKeyedToAPerson",
  // `news_delivery.personId`: which mailing reached whom.
  newsMailings: "notOnTheReport",
  // `invitation.personId`: who was invited to an account, and when.
  signupRequestsAndInvitations: "notOnTheReport",
};

/**
 * The access report's sections as they were named in its audit entry before
 * the map existed. Written out once, so the entry's content is shown not to
 * change by the list moving here.
 */
const SECTIONS_BEFORE_THE_MAP = [
  "person",
  "residencies",
  "boardPositions",
  "systemRoles",
  "account",
  "connectedApps",
  "memberRegisterEntries",
  "transfers",
  "transferReversals",
  "terminations",
  "lienNotes",
  "registerReportObligations",
  "publicationConsents",
  "legalHolds",
  "issues",
  "documents",
  "apartmentDocuments",
  "bookings",
  "motions",
  "subletApplications",
  "keyOrders",
  "eventSignups",
  "memberCharges",
  "fees",
  "feeNotices",
  "newsComments",
  "chats",
  "chatReports",
  "boardMailboxThreads",
  "meetingAttendances",
  "proxyAuthorisations",
  "auditEntries",
  "dataSubjectRequests",
  "personalDataBreaches",
];

describe("the map from the access report to the record", () => {
  it("maps every section of the access report to a row of the record", () => {
    /*
     * The compiler checks the type; this checks the value survives any cast,
     * so a row renamed in the seed and not here fails with the section named.
     */
    const offenders = ENTRIES.flatMap(([section, entry]) =>
      "row" in entry && !(SEED_KEYS as readonly string[]).includes(entry.row)
        ? [
            `${section} names the row ${entry.row}, which is not in SEED_KEYS: ` +
              "the record has no such processing",
          ]
        : [],
    );

    expect(offenders).toEqual([]);
  });

  it("lets only the document's own parts map to no row", () => {
    /*
     * The date, the controller and the derived retention answer are the
     * document rather than data the association holds. A new section cannot be
     * declared part of the document without editing this list in review.
     */
    const documentParts = ENTRIES.filter(
      ([, entry]) => "documentPart" in entry,
    ).map(([section]) => section);

    expect(
      documentParts,
      "a section of the access report maps to no row of the record of " +
        "processing activities: give it the row that covers it in " +
        "SECTION_PROCESSING, and add the row to SEED_KEYS if there is none",
    ).toEqual(["generatedOn", "housingCooperative", "retention"]);
  });

  it("reaches every row of the record from a section, or says why it cannot", () => {
    const reached = new Set(
      ENTRIES.flatMap(([, entry]) => ("row" in entry ? [entry.row] : [])),
    );

    const unreached = SEED_KEYS.filter(
      (key) => !reached.has(key) && ROWS_WITHOUT_A_SECTION[key] === undefined,
    ).map(
      (key) =>
        `${key} is reached by no section of the access report: map the ` +
        "section that carries its data to it, or list it in " +
        "ROWS_WITHOUT_A_SECTION with the reason",
    );
    const listedButReached = (Object.keys(ROWS_WITHOUT_A_SECTION) as SeedKey[])
      .filter((key) => reached.has(key))
      .map(
        (key) =>
          `${key} is listed in ROWS_WITHOUT_A_SECTION but a section maps to ` +
          "it: take it off the list",
      );
    const listedButGone = (Object.keys(ROWS_WITHOUT_A_SECTION) as string[])
      .filter((key) => !(SEED_KEYS as readonly string[]).includes(key))
      .map(
        (key) =>
          `${key} is listed in ROWS_WITHOUT_A_SECTION and is no longer a row ` +
          "of the record",
      );

    expect([...unreached, ...listedButReached, ...listedButGone]).toEqual([]);
  });

  it("names in the audit entry every section with a row, in the report's order", () => {
    const withARow = ENTRIES.filter(([, entry]) => "row" in entry).map(
      ([section]) => section,
    );

    expect([...REPORTED_SECTIONS]).toEqual(withARow);
    expect([...REPORTED_SECTIONS]).toEqual(SECTIONS_BEFORE_THE_MAP);
  });
});

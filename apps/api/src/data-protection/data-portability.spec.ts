import type { TFunction } from "i18next";
import { describe, expect, it } from "vitest";

import type { DataSubjectReport } from "../retention/data-subject-report";
import {
  TRANSMISSION_NOTE_KEY,
  toDataPortabilityExport,
} from "./data-portability";

/**
 * What art. 20 covers, and what it does not.
 *
 * The projection is one function over the access report, so what is worth
 * asserting is the narrowing: art. 20 gives a person back what they gave, on a
 * consent or a contract, and the association's own account of them stays on the
 * art. 15 report. A field that leaked from the second into the first would be
 * the association handing over a statutory record it may not erase and the
 * person never provided.
 */

/** A report with something in every section the projection could reach. */
const REPORT = {
  generatedOn: "2026-09-06",
  housingCooperative: {
    name: "Brf Eksemplet",
    organizationNumber: "769600-0000",
  },
  person: {
    personId: "person-1",
    firstName: "Astrid",
    lastName: "Lindqvist",
    postalAddress: {
      street: "Storgatan 1",
      postalCode: "11122",
      city: "Stockholm",
    },
    alternativePostalAddress: null,
    email: "astrid@exempel.se",
    phone: "070-1234567",
    personalIdentityNumber: "19850101-0017",
    protectedPersonalData: false,
    preferredLocale: "sv",
    recordedAt: "2020-01-01T00:00:00.000Z",
  },
  residencies: [{ residencyId: "res-1" }],
  boardPositions: [{ position: "CHAIR" }],
  systemRoles: ["ADMIN"],
  account: {
    email: "astrid@exempel.se",
    twoFactorEnabled: true,
    createdAt: "x",
  },
  connectedApps: [
    {
      clientName: "Anteckningsappen",
      clientHost: "app.exempel.test",
      scopes: ["mcp:read", "offline_access"],
      connectedAt: "2026-08-01T09:00:00.000Z",
      // The association's own observation of the connection working, which the
      // export must not carry.
      lastUsedAt: "2026-09-05T07:30:00.000Z",
    },
  ],
  memberRegisterEntries: [{ entryId: "entry-1" }],
  transfers: [{ transferId: "transfer-1" }],
  transferReversals: [{ reversalId: "reversal-1" }],
  terminations: [{ terminationId: "termination-1" }],
  lienNotes: [{ lienNoteId: "lien-1" }],
  registerReportObligations: [{ obligationId: "obligation-1" }],
  publicationConsents: [{ scope: "PHOTO" }],
  legalHolds: [{ holdId: "hold-1", reason: "Tvist" }],
  issues: [{ issueId: "issue-1" }],
  documents: [{ documentId: "document-1" }],
  bookings: [{ bookingId: "booking-1" }],
  motions: [{ motionId: "motion-1" }],
  eventSignups: [{ signupId: "signup-1" }],
  memberCharges: [{ chargeId: "charge-1" }],
  fees: [{ feeId: "fee-1" }],
  feeNotices: [{ noticeId: "notice-1" }],
  newsComments: [{ commentId: "comment-1" }],
  chats: [{ chatKind: "BOARD", messages: [{ messageId: "message-1" }] }],
  boardMailboxThreads: [{ threadId: "thread-1" }],
  meetingAttendances: [{ attendanceId: "attendance-1" }],
  proxyAuthorisations: [{ authorisationId: "authorisation-1" }],
  auditEntries: [{ entryId: "audit-1" }],
  dataSubjectRequests: [
    {
      requestId: "request-1",
      kind: "ERASURE",
      requestedOn: "2026-09-01",
      ground: "Jag vill inte längre finnas kvar.",
      erasureGround: "NO_LONGER_NECESSARY",
      issueId: null,
      // The association's own answer, which the export must not carry.
      decision: "REFUSED",
      decisionGround: "Bostadsrätten är inte överlåten.",
      decidedAt: "2026-09-03T09:00:00.000Z",
      executedAt: null,
      closedAt: "2026-09-03T09:00:00.000Z",
      closeReason: "Avslagen.",
    },
  ],
  personalDataBreaches: [{ breachId: "breach-1" }],
  subletApplications: [
    {
      applicationId: "sublet-1",
      apartment: "1001",
      periodFrom: "2029-02-01",
      periodTo: "2029-08-31",
      reason: "Provsamboende på annan ort.",
      submittedAt: "2028-11-01T09:00:00.000Z",
      // The association's own answer, which the export must not carry.
      status: "CONSENTED",
      closedAt: "2028-11-14T09:00:00.000Z",
      decisionNote: "Styrelsen samtycker för hela perioden.",
      tribunalPermittedOn: "2028-12-01",
      tribunalPermittedUntil: "2029-08-31",
      erasableFrom: "2031-08-31",
    },
  ],
  keyOrders: [
    {
      orderId: "key-1",
      apartment: "1001",
      kind: "TAG",
      quantity: 2,
      note: "Taggar till tvättstugan.",
      submittedAt: "2028-11-01T09:00:00.000Z",
      // The association's own answer, which the export must not carry.
      status: "HANDED_OVER",
      closedAt: "2028-11-03T09:00:00.000Z",
      boardNote: "Utlämnade i expeditionen.",
      erasableFrom: "2029-11-03",
    },
  ],
  retention: {
    daysAfterMoveOut: 365,
    purgeOn: "2027-01-01",
    onLegalHold: true,
  },
} as unknown as DataSubjectReport;

/**
 * The key back rather than a sentence, so the cases assert which key the file
 * carries and not one locale's wording of it.
 */
const t = ((key: string) => key) as unknown as TFunction;

/** Every section name on the access report, as the type declares them. */
const REPORT_SECTIONS = new Set(Object.keys(REPORT));

/**
 * What the export does with each section of the access report.
 *
 * One decision per section, and the compiler is what requires it. The export is
 * an allow-list projection over a report that keeps growing, so a section added
 * to the report and forgotten here is data the person can read and cannot take,
 * with nothing about it failing to build - which is how the sublet applications
 * and the key orders arrived missing entirely. `satisfies` closes that: a new
 * section on {@link DataSubjectReport} has no entry here until somebody writes
 * one, and the case below checks each entry against what the projection
 * actually produced.
 *
 * "reportOnly" covers both of art. 20's bounds - what the person did not
 * provide, and what rests on a legal obligation rather than on consent or
 * contract - and the three sections that are not the person's data at all: the
 * two the file's own `about` block is written from, and the retention answer,
 * which states the association's policy rather than a fact about them.
 */
const SECTION_DECISIONS = {
  generatedOn: "reportOnly",
  housingCooperative: "reportOnly",
  person: "carried",
  residencies: "carried",
  boardPositions: "reportOnly",
  systemRoles: "reportOnly",
  account: "reportOnly",
  connectedApps: "carried",
  memberRegisterEntries: "reportOnly",
  transfers: "reportOnly",
  transferReversals: "reportOnly",
  terminations: "reportOnly",
  lienNotes: "reportOnly",
  registerReportObligations: "reportOnly",
  publicationConsents: "carried",
  legalHolds: "reportOnly",
  issues: "carried",
  documents: "carried",
  bookings: "carried",
  motions: "carried",
  subletApplications: "carried",
  keyOrders: "carried",
  eventSignups: "carried",
  memberCharges: "reportOnly",
  fees: "reportOnly",
  feeNotices: "reportOnly",
  newsComments: "carried",
  chats: "carried",
  boardMailboxThreads: "reportOnly",
  meetingAttendances: "reportOnly",
  proxyAuthorisations: "reportOnly",
  auditEntries: "reportOnly",
  dataSubjectRequests: "carried",
  personalDataBreaches: "reportOnly",
  retention: "reportOnly",
} as const satisfies Record<keyof DataSubjectReport, "carried" | "reportOnly">;

/**
 * Asserts a name is a section the report really has before asserting the export
 * leaves it out.
 *
 * A string that matches nothing asserts nothing: rename a section on
 * `DataSubjectReport`, carry the new name into the projection by mistake, and a
 * bare `toBeUndefined` would stay green while statutory register content
 * started travelling in a file a browser downloads.
 */
function expectLeftOnTheReport(
  exported: Record<string, unknown>,
  sections: readonly string[],
): void {
  for (const section of sections) {
    expect(REPORT_SECTIONS).toContain(section);
    expect(exported[section]).toBeUndefined();
  }
}

describe("what the export carries", () => {
  it("gives back what the person provided under a consent or a contract", () => {
    const exported = toDataPortabilityExport(REPORT, t);

    expect(exported.person.email).toBe("astrid@exempel.se");
    expect(exported.residencies).toHaveLength(1);
    expect(exported.bookings).toHaveLength(1);
    expect(exported.motions).toHaveLength(1);
    expect(exported.eventSignups).toHaveLength(1);
    expect(exported.newsComments).toHaveLength(1);
    // The room and the words in it: what somebody wrote is squarely art. 20
    // data, and the room is what the words were said in.
    expect(exported.chats).toHaveLength(1);
    expect(exported.chats[0]?.messages).toHaveLength(1);
    expect(exported.issues).toHaveLength(1);
    expect(exported.publicationConsents).toHaveLength(1);
    expect(exported.connectedApps).toHaveLength(1);
    expect(exported.dataSubjectRequests).toHaveLength(1);
    expect(exported.subletApplications).toHaveLength(1);
    expect(exported.keyOrders).toHaveLength(1);
  });

  it("decides every section of the report, and does what it decided", () => {
    /*
     * The guard on the projection itself rather than on any one section. The
     * fixture puts something in every section, so a carried one being defined
     * means the projection produced it - and a section the table calls carried
     * that has quietly stopped being projected fails here rather than being
     * noticed by the person who asked for their data.
     */
    const exported = toDataPortabilityExport(REPORT, t) as unknown as Record<
      string,
      unknown
    >;

    for (const [section, decision] of Object.entries(SECTION_DECISIONS)) {
      expect(REPORT_SECTIONS, section).toContain(section);
      if (decision === "carried") {
        expect(exported[section], section).toBeDefined();
      } else {
        expect(exported[section], section).toBeUndefined();
      }
    }
  });

  it("says what it is and why it is a file rather than a transfer", () => {
    // In the file itself, because the file outlives the screen that made it.
    const exported = toDataPortabilityExport(REPORT, t);

    expect(exported.about.right).toBe("GDPR art. 20");
    expect(exported.about.transmission).toBe(TRANSMISSION_NOTE_KEY);
    expect(exported.about.association).toBe("Brf Eksemplet");
  });
});

describe("what the export leaves on the access report", () => {
  it("carries no statutory register content, which rests on a legal obligation", () => {
    /*
     * Art. 20(1)(a) reaches processing on consent or contract. The member
     * register, the apartment register and everything hanging off them are kept
     * because the law requires it - which is also why no erasure reaches them.
     */
    const exported = toDataPortabilityExport(REPORT, t) as unknown as Record<
      string,
      unknown
    >;

    expectLeftOnTheReport(exported, [
      "memberRegisterEntries",
      "transfers",
      "terminations",
      "lienNotes",
      "registerReportObligations",
      "meetingAttendances",
      "proxyAuthorisations",
    ]);
  });

  it("carries nothing the association wrote about the person", () => {
    // A board's note, a hold, an audit trail and a breach record are the
    // association's own account. Art. 15 shows them; art. 20 does not give
    // them back, because the person never provided them.
    const exported = toDataPortabilityExport(REPORT, t) as unknown as Record<
      string,
      unknown
    >;

    expectLeftOnTheReport(exported, [
      "legalHolds",
      "auditEntries",
      "personalDataBreaches",
      "boardPositions",
      "systemRoles",
    ]);

    /*
     * And the board's own answer, on the three sections the export does carry.
     * The row is the person's - what they asked for, the period they asked
     * about, what they ordered - and what the association decided about it is
     * not; art. 20(1) reaches the first and not the second.
     *
     * Field by field against the report's own row, so a section that gains an
     * answer field cannot start travelling here unnoticed. An allow-list
     * projection over a report that keeps growing is exactly where that goes
     * wrong, which is how the two sections below arrived missing entirely.
     */
    const carried = toDataPortabilityExport(REPORT, t);
    const answers: Record<string, readonly string[]> = {
      dataSubjectRequests: [
        "decision",
        "decisionGround",
        "decidedAt",
        "executedAt",
        "closedAt",
        "closeReason",
      ],
      subletApplications: [
        "status",
        "closedAt",
        "decisionNote",
        "tribunalPermittedOn",
        "tribunalPermittedUntil",
        "erasableFrom",
      ],
      keyOrders: ["status", "closedAt", "boardNote", "erasableFrom"],
      /*
       * The grant is theirs; when the association last issued a token for it is
       * the association's own observation of the connection working, and the
       * token rows it is read from never leave the instance in any form.
       */
      connectedApps: ["lastUsedAt"],
    };

    for (const [section, fields] of Object.entries(answers)) {
      const reported = (REPORT as unknown as Record<string, unknown[]>)[
        section
      ]?.[0] as Record<string, unknown> | undefined;
      const row = (carried as unknown as Record<string, unknown[]>)[
        section
      ]?.[0] as Record<string, unknown> | undefined;

      for (const field of fields) {
        // The report really carries it, so its absence below means something.
        expect(reported?.[field]).toBeDefined();
        expect(row?.[field]).toBeUndefined();
      }
    }
  });

  it("carries no personal identity number, although the person gave it", () => {
    /*
     * Confidential apartment register content under BRL 9 kap., held on a legal
     * obligation rather than on consent or contract. The product's rule
     * throughout is that it leaves the register only through the audited
     * reveal, never into a file a browser downloads.
     */
    const serialised = JSON.stringify(toDataPortabilityExport(REPORT, t));

    expect(serialised).not.toContain("19850101-0017");
    expect(serialised).not.toContain("personalIdentityNumber");
  });
});

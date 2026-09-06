import { describe, expect, it } from "vitest";

import type { DataSubjectReport } from "../retention/data-subject-report";
import { TRANSMISSION_NOTE, toDataPortabilityExport } from "./data-portability";

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
  memberRegisterEntries: [{ entryId: "entry-1" }],
  transfers: [{ transferId: "transfer-1" }],
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
  newsComments: [{ commentId: "comment-1" }],
  meetingAttendances: [{ attendanceId: "attendance-1" }],
  proxyAuthorisations: [{ authorisationId: "authorisation-1" }],
  auditEntries: [{ entryId: "audit-1" }],
  dataSubjectRequests: [{ requestId: "request-1" }],
  personalDataBreaches: [{ breachId: "breach-1" }],
  retention: {
    daysAfterMoveOut: 365,
    purgeOn: "2027-01-01",
    onLegalHold: true,
  },
} as unknown as DataSubjectReport;

describe("what the export carries", () => {
  it("gives back what the person provided under a consent or a contract", () => {
    const exported = toDataPortabilityExport(REPORT);

    expect(exported.person.email).toBe("astrid@exempel.se");
    expect(exported.residencies).toHaveLength(1);
    expect(exported.bookings).toHaveLength(1);
    expect(exported.motions).toHaveLength(1);
    expect(exported.eventSignups).toHaveLength(1);
    expect(exported.newsComments).toHaveLength(1);
    expect(exported.issues).toHaveLength(1);
    expect(exported.publicationConsents).toHaveLength(1);
    expect(exported.dataSubjectRequests).toHaveLength(1);
  });

  it("says what it is and why it is a file rather than a transfer", () => {
    // In the file itself, because the file outlives the screen that made it.
    const exported = toDataPortabilityExport(REPORT);

    expect(exported.about.right).toBe("GDPR art. 20");
    expect(exported.about.transmission).toBe(TRANSMISSION_NOTE);
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
    const exported = toDataPortabilityExport(REPORT) as unknown as Record<
      string,
      unknown
    >;

    for (const section of [
      "memberRegisterEntries",
      "transfers",
      "terminations",
      "lienNotes",
      "registerReportObligations",
      "meetingAttendances",
      "proxyAuthorisations",
    ]) {
      expect(exported[section]).toBeUndefined();
    }
  });

  it("carries nothing the association wrote about the person", () => {
    // A board's note, a hold, an audit trail and a breach record are the
    // association's own account. Art. 15 shows them; art. 20 does not give
    // them back, because the person never provided them.
    const exported = toDataPortabilityExport(REPORT) as unknown as Record<
      string,
      unknown
    >;

    expect(exported["legalHolds"]).toBeUndefined();
    expect(exported["auditEntries"]).toBeUndefined();
    expect(exported["personalDataBreaches"]).toBeUndefined();
    expect(exported["boardPositions"]).toBeUndefined();
    expect(exported["systemRoles"]).toBeUndefined();
  });

  it("carries no personal identity number, although the person gave it", () => {
    /*
     * Confidential apartment register content under BRL 9 kap., held on a legal
     * obligation rather than on consent or contract. The product's rule
     * throughout is that it leaves the register only through the audited
     * reveal, never into a file a browser downloads.
     */
    const serialised = JSON.stringify(toDataPortabilityExport(REPORT));

    expect(serialised).not.toContain("19850101-0017");
    expect(serialised).not.toContain("personalIdentityNumber");
  });
});

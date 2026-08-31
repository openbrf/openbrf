import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import "../i18n";
import { DataSubjectReport } from "./DataSubjectReport";
import type { DataSubjectReport as Report } from "./register-api";

/**
 * The data subject access report as a document.
 *
 * Three things are worth pinning on this side. That the report is asked for
 * once, on a deliberate mount, because every request decrypts a personal
 * identity number and writes an audit entry. That an empty section is said in
 * words rather than left blank - this document's whole job is to be a complete
 * statement, and a gap reads as something lost. And that there is no way to
 * send it: it is printed and handed over, never mailed.
 */

const IDENTITY_NUMBER = "19850101-0017";

const { fetchDataSubjectReport } = vi.hoisted(() => ({
  fetchDataSubjectReport: vi.fn(),
}));

vi.mock("./register-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./register-api")>()),
  fetchDataSubjectReport,
}));

const EMPTY_REPORT: Report = {
  generatedOn: "2026-08-29",
  housingCooperative: { name: "Brf Eksemplet", organizationNumber: null },
  person: {
    personId: "person-siv",
    firstName: "Siv",
    lastName: "Holm",
    postalAddress: { street: null, postalCode: null, city: null },
    alternativePostalAddress: null,
    email: null,
    phone: null,
    personalIdentityNumber: null,
    protectedPersonalData: false,
    preferredLocale: "sv",
    recordedAt: "2020-03-01T09:00:00.000Z",
  },
  residencies: [],
  boardPositions: [],
  systemRoles: [],
  account: null,
  memberRegisterEntries: [],
  transfers: [],
  lienNotes: [],
  publicationConsents: [],
  legalHolds: [],
  issues: [],
  documents: [],
  bookings: [],
  auditEntries: [],
  retention: { daysAfterMoveOut: 365, purgeOn: null, onLegalHold: false },
};

const FULL_REPORT: Report = {
  ...EMPTY_REPORT,
  lienNotes: [
    {
      lienNoteId: "lien-1",
      apartment: "Storgatan 12 1001",
      creditor: "Exempelbanken",
      amount: "450000.00",
      notedOn: "2016-05-01",
      releasedOn: null,
    },
  ],
  housingCooperative: {
    name: "Brf Eksemplet",
    organizationNumber: "769600-0000",
  },
  person: {
    ...EMPTY_REPORT.person,
    postalAddress: {
      street: "Storgatan 12",
      postalCode: "11122",
      city: "Stockholm",
    },
    email: "siv@exempel.test",
    phone: "+46701234567",
    personalIdentityNumber: IDENTITY_NUMBER,
  },
  residencies: [
    {
      residencyId: "residency-1",
      apartmentNumber: "1201",
      addressLabel: "Storgatan 12",
      role: "MEMBER",
      movedInOn: "2020-03-01",
      movedOutOn: "2026-02-01",
      purgeOn: "2027-02-01",
    },
  ],
  memberRegisterEntries: [
    {
      entryId: "entry-1",
      eventType: "EXIT",
      eventOn: "2026-02-01",
      apartment: "Storgatan 12 1201",
      recordedName: "Siv Holm",
      recordedPostalAddress: {
        street: "Storgatan 12",
        postalCode: "11122",
        city: "Stockholm",
      },
      note: null,
    },
  ],
  legalHolds: [
    {
      holdId: "hold-1",
      reason: "Tvist om andrahandsuthyrning",
      placedAt: "2026-02-10T09:00:00.000Z",
      releasedAt: null,
      releaseReason: null,
    },
  ],
  bookings: [
    {
      bookingId: "booking-1",
      resourceName: "Tvättstugan",
      status: "BOOKED",
      startsAt: "2026-01-17T07:00:00.000Z",
      endsAt: "2026-01-17T09:00:00.000Z",
      apartment: "Storgatan 12 1201",
      // A year after the booking ended, and deliberately not the date the
      // retention section below states: a booking is erased on its own clock.
      erasableFrom: "2027-01-17",
    },
  ],
  auditEntries: [
    {
      entryId: "audit-1",
      role: "subject",
      action: "PROTECTED_DATA_REVEALED",
      at: "2026-02-11T09:00:00.000Z",
      targetKind: null,
      targetId: null,
      context: { fields: ["phone"] },
    },
  ],
  retention: {
    daysAfterMoveOut: 365,
    purgeOn: "2027-02-01",
    onLegalHold: true,
  },
};

const noop = (): void => {
  /* intentionally empty */
};

function renderReport(report: Report) {
  fetchDataSubjectReport.mockResolvedValue(report);
  return render(
    <DataSubjectReport personId={report.person.personId} onClose={noop} />,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("producing the report", () => {
  it("asks for it once, on mount", async () => {
    renderReport(FULL_REPORT);

    await screen.findByText("Brf Eksemplet");
    // Every request decrypts a personal identity number and writes an audit
    // entry, so a render that asked a second time would be a second
    // disclosure nobody chose.
    expect(fetchDataSubjectReport).toHaveBeenCalledTimes(1);
    expect(fetchDataSubjectReport).toHaveBeenCalledWith(
      "person-siv",
      expect.anything(),
    );
  });

  it("says the report was written to the audit log", async () => {
    renderReport(FULL_REPORT);

    expect(
      (await screen.findAllByText(/skrivet till granskningsloggen/i)).length,
    ).toBeGreaterThan(0);
  });

  it("offers no way to send it", async () => {
    // There is no email path in the API and there must be none on screen: the
    // document carries a personal identity number, and a mailed copy would
    // pass through two mail systems on its way.
    renderReport(FULL_REPORT);
    await screen.findByText("Brf Eksemplet");

    expect(screen.queryByRole("button", { name: /skicka/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /e-post/i })).toBeNull();
  });

  it("says so when the report could not be produced", async () => {
    fetchDataSubjectReport.mockRejectedValue(new Error("refused"));
    render(<DataSubjectReport personId="person-siv" onClose={noop} />);

    await waitFor(() => {
      expect(
        screen.getByText("Registerutdraget kunde inte tas fram. Försök igen."),
      ).not.toBeNull();
    });
  });
});

describe("what the document prints", () => {
  it("carries both tiers and says which is which", async () => {
    renderReport(FULL_REPORT);
    await screen.findByText("Brf Eksemplet");

    expect(screen.getByText("Medlemsförteckningen")).not.toBeNull();
    expect(screen.getByText("Boenden")).not.toBeNull();
    // The sentence that tells the reader which half is erased on the date
    // below and which half the law requires the association to keep.
    expect(screen.getByText(/bevaras så länge lagen kräver/i)).not.toBeNull();
  });

  it("prints the values that came back, and invents none", async () => {
    renderReport(FULL_REPORT);
    await screen.findByText("Brf Eksemplet");

    expect(screen.getByText(IDENTITY_NUMBER)).not.toBeNull();
    expect(screen.getByText("siv@exempel.test")).not.toBeNull();
    expect(screen.getByText("Storgatan 12, 11122, Stockholm")).not.toBeNull();
  });

  it("states the purge date and that a hold suspends it", async () => {
    renderReport(FULL_REPORT);
    await screen.findByText("Brf Eksemplet");

    expect(screen.getAllByText("2027-02-01").length).toBeGreaterThan(0);
    expect(screen.getByText("Tvist om andrahandsuthyrning")).not.toBeNull();
  });

  it("names the audit action in the reader's own language", async () => {
    // The document is handed to the person it is about, so the action column
    // cannot print PROTECTED_DATA_REVEALED at them.
    renderReport(FULL_REPORT);
    await screen.findByText("Brf Eksemplet");

    expect(screen.getByText("Skyddade uppgifter visades")).not.toBeNull();
    expect(screen.queryByText("PROTECTED_DATA_REVEALED")).toBeNull();
  });

  it("prints a standing lien note, and says that it stands", async () => {
    // A pledge with no release date is not a missing field: the document has to
    // say that it is still in force.
    renderReport(FULL_REPORT);
    await screen.findByText("Brf Eksemplet");

    expect(screen.getByText("Pantnoteringar")).not.toBeNull();
    expect(screen.getByText("Exempelbanken")).not.toBeNull();
    expect(screen.getByText("Gäller fortfarande")).not.toBeNull();
  });

  it("prints a booking with the earliest date it can be erased on", async () => {
    /*
     * The one section that states a retention date per row. A booking is erased
     * a year after it ended, on its own clock, so printing the document's own
     * purge date here would tell the person a date that is not going to happen
     * to this row.
     *
     * And the column says the earliest such date rather than the day it goes,
     * which is the difference this fixture exists to hold: the person it
     * describes is under a standing legal hold, so nothing of theirs is being
     * erased at all until the board releases it. A column headed "Gallras" here
     * would be a retention promise the association is not going to keep, made
     * to the one person entitled to rely on it. The hold itself is stated in
     * the retention section, which is where this document answers whether one
     * stands.
     */
    renderReport(FULL_REPORT);
    await screen.findByText("Brf Eksemplet");

    expect(screen.getByText("Bokningar")).not.toBeNull();
    expect(screen.getByText("Tvättstugan")).not.toBeNull();
    expect(screen.getByText("Bokad")).not.toBeNull();
    expect(screen.getByText("Gallras tidigast")).not.toBeNull();
    expect(screen.getByText("2027-01-17")).not.toBeNull();

    // And the hold state that makes that wording load-bearing, stated on the
    // same page, so the two are read together.
    expect(screen.getByText("Rättsligt bevarandekrav")).not.toBeNull();
  });

  it("says an empty section is empty rather than leaving a gap", async () => {
    // A printed document with a blank under a heading reads as one that lost
    // something. The report's whole job is to be a complete statement of what
    // the association holds, including where it holds nothing.
    renderReport(EMPTY_REPORT);
    await screen.findByText("Brf Eksemplet");

    expect(screen.getByText("Överlåtelser")).not.toBeNull();
    expect(screen.getAllByText("Inget registrerat").length).toBeGreaterThan(5);
  });
});

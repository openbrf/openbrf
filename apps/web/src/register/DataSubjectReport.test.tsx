import {
  getDefaultNormalizer,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
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

/** A comment that stands, and one the board struck through. */
const STANDING_COMMENT = "Tack for beskedet om porten.";
const STRUCK_COMMENT = "Detta togs bort av styrelsen.";

/**
 * A fault report written on three lines, as a resident writes one.
 *
 * Free text with line breaks in it, so the assertion below is about what the
 * document does to somebody's own writing rather than about whether it printed
 * a string at all.
 */
const ISSUE_DESCRIPTION = [
  "Porten gar inte igen.",
  "Den slar upp igen nar man slapper.",
  "Varst pa morgonen.",
].join("\n");

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
  terminations: [],
  lienNotes: [],
  registerReportObligations: [],
  publicationConsents: [],
  legalHolds: [],
  issues: [],
  documents: [],
  bookings: [],
  motions: [],
  eventSignups: [],
  newsComments: [],
  meetingAttendances: [],
  proxyAuthorisations: [],
  auditEntries: [],
  retention: { daysAfterMoveOut: 365, purgeOn: null, onLegalHold: false },
};

const FULL_REPORT: Report = {
  ...EMPTY_REPORT,
  transfers: [
    {
      transferId: "transfer-1",
      apartment: "Storgatan 12 1201",
      direction: "acquired",
      transferredOn: "2020-03-01",
      // The day the two-week reporting window opened for this transfer, which
      // is not the day the transfer completed.
      membershipDecidedOn: "2020-02-18",
      price: "2950000.00",
      agreementReference: "Overlatelseavtal 2020-7",
    },
  ],
  terminations: [
    {
      terminationId: "termination-1",
      apartment: "Storgatan 12 1201",
      kind: "GENERAL_MEETING_DECISION",
      tookEffectOn: "2026-02-01",
      reference: "Stammoprotokoll 2026-1",
    },
  ],
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
  registerReportObligations: [
    {
      obligationId: "obligation-1",
      kind: "TRANSFER",
      apartment: "Storgatan 12 1201",
      // The membership decision above, and fourteen days on from it. Not the
      // day the transfer completed, which is a fortnight later again.
      triggeredOn: "2020-02-18",
      dueOn: "2020-03-03",
    },
    {
      obligationId: "obligation-2",
      kind: "TERMINATION",
      apartment: "Storgatan 12 1201",
      triggeredOn: "2026-02-01",
      dueOn: "2026-02-15",
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
  issues: [
    {
      issueId: "issue-1",
      typeName: "Porten",
      status: "IN_PROGRESS",
      location: "Storgatan 12, entren",
      description: ISSUE_DESCRIPTION,
      reportedAt: "2026-01-05T08:00:00.000Z",
      photographs: 2,
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
  motions: [
    {
      motionId: "motion-1",
      title: "Laddstolpar i garaget",
      body: "Foreningen bor utreda vad laddstolpar skulle kosta.",
      status: "ACKNOWLEDGED",
      submittedAt: "2027-01-20T09:00:00.000Z",
      closedAt: "2027-04-15T12:00:00.000Z",
      // Two years after it was closed, and deliberately neither the date the
      // retention section states nor the bookings' one: a motion is erased on a
      // clock of its own.
      erasableFrom: "2029-04-14",
    },
    {
      motionId: "motion-2",
      title: "Cykelstall pa gaveln",
      body: "Fler platser behovs.",
      status: "SUBMITTED",
      submittedAt: "2027-01-25T09:00:00.000Z",
      // Still with the board, so there is no closing date to count from.
      closedAt: null,
      erasableFrom: null,
    },
  ],
  eventSignups: [
    {
      signupId: "signup-1",
      eventTitle: "Städdag",
      /*
       * Half past midnight local, so the instant falls on the day before in UTC.
       * The server states the local date and the document prints what it was
       * given; a column that read the day off the instant here would name the
       * 17th of April on a document about the 18th.
       */
      startsAt: "2027-04-17T22:30:00.000Z",
      endsAt: "2027-04-18T02:30:00.000Z",
      on: "2027-04-18",
      signedUpAt: "2027-03-01T10:00:00.000Z",
      // Stood down, which is a date on the row rather than an absent row.
      withdrawnOn: "2027-03-20T12:00:00.000Z",
      calledOff: false,
      erasableFrom: "2028-04-17",
    },
  ],
  newsComments: [
    {
      commentId: "comment-1",
      newsTitle: "Portkoden byts",
      newsSlug: "portkoden-byts",
      body: STANDING_COMMENT,
      hidden: false,
      writtenAt: "2026-01-20T18:00:00.000Z",
      erasableFrom: "2027-01-20",
    },
    {
      commentId: "comment-2",
      newsTitle: "Stamning i tvattstugan",
      newsSlug: "stamning-i-tvattstugan",
      body: STRUCK_COMMENT,
      hidden: true,
      writtenAt: "2026-01-21T18:00:00.000Z",
      erasableFrom: "2027-01-21",
    },
  ],
  /*
   * Two lines at one meeting, which is the ordinary case rather than an edge
   * one: somebody who arrives holding a neighbour's fullmakt is on the list as a
   * member and as an ombud, with two votes and one body. The second line is also
   * what makes the struck-off column readable - it carries a date where the
   * first carries none.
   */
  meetingAttendances: [
    {
      attendanceId: "attendance-1",
      meetingHeldOn: "2027-05-12",
      meetingKind: "ORDINARY",
      capacity: "MEMBER",
      mode: "IN_PERSON",
      onBehalfOfPersonId: null,
      withdrawnAt: null,
    },
    {
      attendanceId: "attendance-2",
      meetingHeldOn: "2027-05-12",
      meetingKind: "ORDINARY",
      capacity: "PROXY_HOLDER",
      mode: "IN_PERSON",
      onBehalfOfPersonId: null,
      withdrawnAt: "2027-05-12T18:20:00.000Z",
    },
  ],
  /*
   * One appointment on each side of the person, which is what this section
   * exists to be able to print: they gave their own vote away at one meeting and
   * carried a neighbour's at another. A section answering for one role only
   * would show one of these two rows.
   */
  proxyAuthorisations: [
    {
      authorisationId: "proxy-1",
      meetingHeldOn: "2026-05-20",
      meetingKind: "ORDINARY",
      role: "member",
      counterpartPersonId: "person-erik",
      ground: "SPOUSE_OR_COHABITANT",
      authorisedOn: "2026-05-02",
      withdrawnAt: null,
    },
    {
      authorisationId: "proxy-2",
      meetingHeldOn: "2027-05-12",
      meetingKind: "ORDINARY",
      role: "proxyHolder",
      counterpartPersonId: "person-nils",
      ground: "MEMBER",
      authorisedOn: "2027-04-30",
      withdrawnAt: "2027-05-11T08:00:00.000Z",
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
    // The moderation the news comment section states as a yes, seen from the
    // log's side: the board hid this person's comment, and the document has to
    // name that act in the reader's own language as well.
    {
      entryId: "audit-2",
      role: "subject",
      action: "NEWS_COMMENT_HIDDEN",
      at: "2026-01-22T09:00:00.000Z",
      targetKind: "newsComment",
      targetId: "comment-2",
      context: { newsId: "news-1" },
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

/**
 * The value the document states against one of its field labels.
 *
 * Read as a pair rather than searched for on its own, because the report
 * answers three questions with the same two words: whether the person has
 * protected personal data, whether their account carries a second factor, and
 * whether a legal hold stands. An assertion on the word alone is satisfied by
 * any of the three, so a wrong answer to one of them would pass unseen. This
 * reads the label and its value together, the way somebody holding the printed
 * page does.
 */
function fieldValue(label: string): string {
  const term = screen.getByText(label);
  const value = term.parentElement?.querySelector("dd");
  if (!value) {
    throw new Error(`The report states no value against "${label}".`);
  }
  return value.textContent ?? "";
}

/**
 * One section of the document, found by the heading printed above it.
 *
 * Sections share column headings - bookings, motions, event sign-ups and news
 * comments all state the earliest date the purge can reach a row - so an
 * assertion on a heading alone is satisfied by whichever section happens to be
 * found first, and would go on passing if the section it was written about
 * stopped printing the column entirely.
 */
function sectionOf(heading: string): HTMLElement {
  const title = screen.getByText(heading);
  const section = title.closest("section");
  if (!section) {
    throw new Error(`The report prints no section headed "${heading}".`);
  }
  return section;
}

/**
 * What the news comment section says about one comment being hidden.
 *
 * Found by its body and read across that row, because "Ja" and "Nej" appear
 * against several unrelated questions on this document: a search for the word
 * alone would be satisfied by the protected-data field or the legal hold, and a
 * column that had stopped saying anything at all would pass unnoticed.
 */
function hiddenColumnOf(body: string): string {
  const cells = screen.getByText(body).closest("tr")?.querySelectorAll("td");
  if (cells === undefined) {
    throw new Error(`The report prints no comment row for "${body}".`);
  }
  const hidden = [...cells].find(
    (cell) => cell.textContent === "Ja" || cell.textContent === "Nej",
  );
  if (hidden === undefined) {
    throw new Error(`The comment row for "${body}" says nothing about hiding.`);
  }
  return hidden.textContent ?? "";
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

    // Asserted per action rather than only for one of them: the map from action
    // to label is total, so a missing entry is a build failure, but an entry
    // pointing at the wrong action still prints the wrong sentence.
    expect(screen.getByText("Nyhetskommentar doldes")).not.toBeNull();
    expect(screen.queryByText("NEWS_COMMENT_HIDDEN")).toBeNull();
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
     * The first of the four sections that state a retention date per row. A
     * booking is erased a year after it ended, on its own clock, so printing the
     * document's own purge date here would tell the person a date that is not
     * going to happen to this row.
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

    /*
     * Read out of the bookings section rather than off the page. Four sections
     * carry this column now - bookings, motions, event sign-ups and news
     * comments, each purged on a clock of its own - so a count has to be
     * revised every time another module purges, and a bare query would pass
     * while pointing at the wrong table.
     */
    const bookings = within(sectionOf("Bokningar"));
    expect(bookings.getByText("Tvättstugan")).not.toBeNull();
    expect(bookings.getByText("Bokad")).not.toBeNull();
    expect(bookings.getByText("Gallras tidigast")).not.toBeNull();
    expect(bookings.getByText("2027-01-17")).not.toBeNull();

    // And the hold state that makes that wording load-bearing, stated on the
    // same page, so the two are read together. Asserted as the answer and not
    // as the presence of the question: the label renders either way, so a
    // document that told this person nothing was being kept would satisfy a
    // test that only looked for the heading - and that is the disclosure the
    // column above is worded around.
    expect(fieldValue("Rättsligt bevarandekrav")).toBe("Ja");
  });

  it("prints a motion in the member's own words, with its own erasure date", async () => {
    /*
     * The second section that states a retention date per row, and the one where
     * the absence of a date is itself the answer.
     *
     * A closed motion is erased two years after it closed - not on the
     * document's own purge date, and not on the bookings' one-year clock. An
     * open motion states no date at all, because there is no closing date to
     * count from and the association is still processing it. A dash there is a
     * true statement; a date would promise an erasure nothing is going to
     * perform, and the document's own purge date would promise the wrong one.
     *
     * The body is printed as written. It is the person's own proposal and the
     * fullest answer art. 15 can give about it, so a summary would be the
     * association paraphrasing them back to themselves.
     */
    renderReport(FULL_REPORT);
    await screen.findByText("Brf Eksemplet");

    expect(screen.getByText("Motioner")).not.toBeNull();
    expect(screen.getByText("Laddstolpar i garaget")).not.toBeNull();
    expect(
      screen.getByText("Foreningen bor utreda vad laddstolpar skulle kosta."),
    ).not.toBeNull();
    expect(screen.getByText("Mottagen")).not.toBeNull();

    // Two years after the closing date, and distinct from both the booking's
    // date and the document's own - which is what makes this row's column
    // meaningful rather than decorative.
    expect(screen.getByText("2029-04-14")).not.toBeNull();
    expect(screen.getByText("2027-04-15")).not.toBeNull();

    // The open motion, whose erasure date is deliberately absent.
    const openRow = screen.getByText("Cykelstall pa gaveln").closest("tr");
    expect(openRow).not.toBeNull();
    expect(openRow?.textContent).toContain("Hos styrelsen");
    // Two dashes on that row: no closing date and no erasure date.
    expect(
      [...(openRow?.querySelectorAll("td") ?? [])].filter((cell) =>
        cell.textContent?.includes("Inget registrerat"),
      ).length,
    ).toBe(2);
  });

  it("prints the termination of a tenant-ownership, on its statutory ground", async () => {
    /*
     * Statutory tier, so no erasure date and no promise of one - the document
     * says instead that the register is kept for as long as the law requires.
     *
     * The ground is printed as the statute's own sentence rather than as the
     * enum value, because this page is handed to the person it is about. A
     * fallback to the code would put GENERAL_MEETING_DECISION on a Swedish
     * document; the label map is total, so it cannot.
     */
    renderReport(FULL_REPORT);
    await screen.findByText("Brf Eksemplet");

    expect(screen.getByText("Upphöranden")).not.toBeNull();
    expect(screen.getByText(/Beslut på föreningsstämma/)).not.toBeNull();
    expect(screen.getByText("Stammoprotokoll 2026-1")).not.toBeNull();
    // The day it took effect, read out of its own row: the same date is the
    // move-out and the register exit as well, so searching the page for it
    // would pass with the termination section printing nothing at all.
    const ceased = screen
      .getByText("Stammoprotokoll 2026-1")
      .closest("tr")?.textContent;
    expect(ceased).toContain("2026-02-01");
    // And the retention sentence that covers it, naming the terminations among
    // what no setting and no administrator reaches.
    expect(screen.getByText(/upphörandena/)).not.toBeNull();
  });

  it("prints each reporting obligation to the cooperative housing register", async () => {
    /*
     * Statutory tier, so no erasure date, like the register sections above it.
     *
     * The two dates are read out of their own rows. Every date in this section
     * appears somewhere else on the document as well - the window opens on the
     * membership decision or on the day a tenant-ownership ceased, both of which
     * are printed above - so searching the page for one would pass with this
     * section printing nothing at all.
     *
     * The kind is printed as a word rather than as the enum value, for the reason
     * the termination ground is: this page is handed to the person it is about.
     */
    renderReport(FULL_REPORT);
    await screen.findByText("Brf Eksemplet");

    expect(
      screen.getByText("Anmälningsskyldigheter till bostadsrättsregistret"),
    ).not.toBeNull();

    const rows = screen
      .getByText("Anmälningsskyldigheter till bostadsrättsregistret")
      .closest("section")
      ?.querySelectorAll("tbody tr");
    expect(rows).toHaveLength(2);
    expect(rows?.[0]?.textContent).toContain("2020-02-18");
    expect(rows?.[0]?.textContent).toContain("2020-03-03");
    expect(rows?.[0]?.textContent).toContain("Överlåtelse");
    expect(rows?.[1]?.textContent).toContain("2026-02-01");
    expect(rows?.[1]?.textContent).toContain("2026-02-15");
    expect(rows?.[1]?.textContent).toContain("Upphörande");

    // And the retention sentence that covers them, naming the reports among
    // what no setting and no administrator reaches.
    expect(
      screen.getByText(/anmälningsskyldigheterna till bostadsrättsregistret/),
    ).not.toBeNull();
  });

  it("prints the day a transfer's membership was decided", async () => {
    // The day the register's two-week window opened, which is a decision taken
    // about this person and a different day from the transfer.
    renderReport(FULL_REPORT);
    await screen.findByText("Brf Eksemplet");

    // Read out of the transfer row, beside the day the transfer completed, so
    // the assertion is about that row rather than about the page carrying the
    // date somewhere.
    const transfer = screen
      .getByText("Overlatelseavtal 2020-7")
      .closest("tr")?.textContent;
    expect(transfer).toContain("2020-03-01");
    expect(transfer).toContain("2020-02-18");
  });

  it("prints a sign-up with its withdrawal date and the association's own day", async () => {
    /*
     * Two things this section has to get right, both of which a report that
     * looked complete could be wrong about.
     *
     * The withdrawal is a date and not an absence. A person who stood down and a
     * person who never signed up are two different answers to an access request,
     * and the association is still holding a row about the first.
     *
     * And the date is the association's own. The fixture's event starts at half
     * past midnight in Stockholm, so its instant is the day before in UTC: a
     * column that derived the day from the instant would print the 17th on a
     * document about the cleaning day on the 18th.
     */
    renderReport(FULL_REPORT);
    await screen.findByText("Brf Eksemplet");

    const signups = within(sectionOf("Anmälningar till evenemang"));
    expect(signups.getByText("Städdag")).not.toBeNull();
    expect(signups.getByText("2027-04-18")).not.toBeNull();
    expect(signups.queryByText("2027-04-17")).toBeNull();
    expect(signups.getByText("2027-03-20")).not.toBeNull();
    // A year after the date ended, on its own clock, exactly as the booking
    // above states its own.
    expect(signups.getByText("Gallras tidigast")).not.toBeNull();
    expect(signups.getByText("2028-04-17")).not.toBeNull();
  });

  it("prints a comment in full, including one the board struck through", async () => {
    /*
     * The body, whole, and for a hidden comment as much as a standing one. A
     * moderated comment is still the person's own words, and this document is
     * the one place they are entitled to read what the board took off the
     * thread; a section that named the notice and the date and left the
     * sentence out would tell them that they commented without telling them
     * what they said.
     *
     * The hidden column is read as the row it belongs to rather than as a word
     * somewhere on the page. This document answers several questions with "Ja"
     * - protected personal data, a second factor, a standing legal hold - so a
     * bare search for it is satisfied by any of them, and both answers are
     * asserted so the column is an answer rather than decoration.
     */
    renderReport(FULL_REPORT);
    await screen.findByText("Brf Eksemplet");

    const comments = within(sectionOf("Nyhetskommentarer"));
    expect(comments.getByText("Portkoden byts")).not.toBeNull();
    expect(comments.getByText("Gallras tidigast")).not.toBeNull();
    expect(comments.getByText("2027-01-20")).not.toBeNull();

    // Both bodies, named rather than reached through the row lookup below. The
    // struck one being printed at all is the art. 15 behaviour this section
    // exists for, and it would go untested if the lookup were later rewritten
    // to find its row by the comment's identifier.
    expect(comments.getByText(STANDING_COMMENT)).not.toBeNull();
    expect(comments.getByText(STRUCK_COMMENT)).not.toBeNull();

    expect(hiddenColumnOf(STRUCK_COMMENT)).toBe("Ja");
    expect(hiddenColumnOf(STANDING_COMMENT)).toBe("Nej");
  });

  it("keeps the line breaks in every piece of the person's own writing", async () => {
    /*
     * Three sections of this document carry free text somebody wrote - a fault
     * report, a motion and a comment - and all three are the person's own
     * words rather than the association's summary of them. A description
     * written as three observations reads as one run-on sentence once the
     * breaks collapse, which is the association altering what it hands back.
     *
     * Asserted as the instruction to keep them rather than as the rendered
     * result, because no stylesheet applies here: the text node holds its
     * newlines either way, so reading the text content would pass against a
     * cell that had dropped the rule. Asserted for all three together so the
     * fourth free-text section cannot arrive without it - the issue
     * description was the one that had been missed.
     *
     * The breaks are also why the match does not collapse whitespace, which is
     * the default: a query that collapsed them would be looking for a string
     * this document must never print.
     */
    renderReport(FULL_REPORT);
    await screen.findByText("Brf Eksemplet");

    const asWritten = getDefaultNormalizer({ collapseWhitespace: false });
    for (const written of [
      ISSUE_DESCRIPTION,
      "Foreningen bor utreda vad laddstolpar skulle kosta.",
      STANDING_COMMENT,
    ]) {
      const printed = screen.getByText(written, { normalizer: asWritten });
      expect(printed.className).toContain("whitespace-pre-line");
    }
  });

  it("names the capacity somebody was present at a general meeting in", async () => {
    /*
     * "Present" is the smaller half of what this section says. EFL 6 kap. 27 §
     * has the list cover the members, ombud and bitraden present, and the three
     * are different facts about a person - own vote, somebody else's vote, or a
     * seat with the right to speak and no vote at all. A section that printed
     * only the meeting and the date would leave its subject unable to see which
     * of those the association wrote down.
     *
     * Read inside the section, because "Medlem" is a word this document prints
     * in the residencies as well.
     */
    renderReport(FULL_REPORT);
    await screen.findByText("Brf Eksemplet");

    const meetings = within(sectionOf("Närvaro vid föreningsstämma"));
    // Both lines, which is what the count asserts: one body in the room is two
    // lines on the list when one of them carries somebody else's vote.
    expect(meetings.getAllByText("Ordinarie föreningsstämma")).toHaveLength(2);
    expect(meetings.getByText("Medlem")).not.toBeNull();
    expect(meetings.getByText("Ombud")).not.toBeNull();
    /*
     * The struck-off column, asserted as a heading the section prints. A line
     * the board took off the list is kept and dated rather than left out,
     * because "was recorded as present and struck off again" is a different fact
     * about somebody from never having been recorded - and it is the fact they
     * would be asking about.
     */
    expect(meetings.getByText("Återkallat")).not.toBeNull();

    /*
     * No erasure column, and asserted as an absence rather than left untested.
     * Nothing purges a line of the meeting's record, so a heading promising a
     * date would promise something the association is not going to do - which is
     * exactly the failure the four sections that do carry the column guard
     * against from the other side.
     */
    expect(meetings.queryByText("Gallras tidigast")).toBeNull();
  });

  it("answers for both sides of a proxy authorisation", async () => {
    /*
     * A fullmakt names two people and both of them have an art. 15 interest in
     * it: the member gave their vote away and the ombud carried somebody else's.
     * The fixture puts this person on one side of one appointment and the other
     * side of another, so a section that answered for one role would print one
     * row and look complete.
     *
     * The counterpart is asserted as the identifier it is. Naming them would put
     * a third party's name on a document the association hands over, which is
     * the reading art. 15(4) forces and the same one the audit log's two person
     * columns are printed under.
     */
    renderReport(FULL_REPORT);
    await screen.findByText("Brf Eksemplet");

    const proxies = within(sectionOf("Fullmakter till ombud"));
    expect(proxies.getByText("Lämnade fullmakt")).not.toBeNull();
    expect(proxies.getByText("Hade fullmakt")).not.toBeNull();
    expect(proxies.getByText("person-erik")).not.toBeNull();
    expect(proxies.getByText("person-nils")).not.toBeNull();
    expect(proxies.getByText("Make, maka eller sambo")).not.toBeNull();
    expect(proxies.getByText("2026-05-02")).not.toBeNull();
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

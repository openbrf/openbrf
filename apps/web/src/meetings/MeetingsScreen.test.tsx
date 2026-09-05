import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import "../i18n";
import type { Viewer } from "../api/instance";
import type { Attendance, Meeting, MeetingSummary } from "../api/meetings";
import { MeetingsScreen } from "./MeetingsScreen";

/**
 * The board's screens for a general meeting, and the rules only a screen can
 * get wrong.
 *
 * The statute is enforced on the server against a real database and is tested
 * there. What this file pins down is the half that lives in the browser.
 *
 * That the state of the meeting decides which panels are forms and which are
 * records, and that both facts come from the answer rather than from a
 * comparison made here. Issuing the notice fixes the agenda; recording the
 * meeting as held closes check-in and the authorities and opens the decisions.
 * A screen that offered a form the server would refuse has told a board the
 * wrong thing at a door.
 *
 * That every act re-reads the meeting whole and none of them folds a write's
 * answer into the screen. The voting register is derived from the member
 * register, the residencies, the attendance lines and the authorities together,
 * and no write answers with it - so a check-in whose answer was believed would
 * leave a list of who is present beside a count of votes that no longer follows
 * from it.
 *
 * That the re-read happens when an act is refused as well as when it lands.
 *
 * That the newest read wins. Two can be in flight at once and both are well
 * formed, so the only rule available is that the older one is dropped;
 * whichever arrives last would otherwise put a struck line back on the list.
 */

const fetchMeetings = vi.fn();
const fetchMeeting = vi.fn();
const recordAttendance = vi.fn();
const withdrawAttendance = vi.fn();

vi.mock("../api/meetings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/meetings")>()),
  fetchMeetings: () => fetchMeetings(),
  fetchMeeting: (id: string) => fetchMeeting(id),
  recordAttendance: (input: unknown) => recordAttendance(input),
  withdrawAttendance: (input: unknown) => withdrawAttendance(input),
}));

const fetchBoardRegister = vi.fn();

vi.mock("../register/register-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../register/register-api")>()),
  fetchBoardRegister: (query: unknown, signal: unknown) =>
    fetchBoardRegister(query, signal),
}));

function viewer(capabilities: readonly string[]): Viewer {
  return {
    personId: "person-board",
    firstName: "Bo",
    lastName: "Bergman",
    preferredLocale: "sv",
    capabilities: [...capabilities],
    housingCooperative: null,
  };
}

/** The two people the address book holds for these tests. */
const REGISTER_PAGE = {
  rows: [
    {
      key: "residency-astrid",
      personId: "person-astrid",
      name: "Astrid Lindqvist",
      apartment: {
        id: "apartment-1001",
        addressId: "a",
        number: "1001",
        floor: 2,
      },
      signs: [],
      movedInOn: "2020-01-01",
      movedOutOn: null,
      contact: { state: "visible" as const, email: null, phone: null },
      purgeOn: null,
      protectedPersonalData: false,
    },
    {
      key: "residency-nils",
      personId: "person-nils",
      name: "Nils Lindqvist",
      apartment: {
        id: "apartment-1001",
        addressId: "a",
        number: "1001",
        floor: 2,
      },
      signs: [],
      movedInOn: "2020-01-01",
      movedOutOn: null,
      contact: { state: "visible" as const, email: null, phone: null },
      purgeOn: null,
      protectedPersonalData: false,
    },
  ],
  addresses: [],
  counts: { all: 2, members: 1, residents: 1, board: 0, movedOut: 0 },
  total: 2,
  page: 1,
  pageSize: 100,
  stats: { apartments: 1, persons: 2, members: 1 },
  generatedOn: "2027-05-01",
};

const SUMMARY: MeetingSummary = {
  id: "meeting-1",
  kind: "ORDINARY",
  heldOn: "2027-05-20",
  concludedAt: null,
  agendaItemCount: 1,
};

/** The one line on the list, named so a test can vary it without indexing. */
const ASTRID_PRESENT: Attendance = {
  id: "attendance-1",
  personId: "person-astrid",
  capacity: "MEMBER",
  mode: "IN_PERSON",
  onBehalfOfPersonId: null,
  withdrawnAt: null,
};

/** A meeting being arranged: no notice, not held, one person checked in. */
const ARRANGING: Meeting = {
  ...SUMMARY,
  agenda: [
    {
      id: "item-1",
      position: 1,
      title: "Val av styrelse",
      decision: null,
    },
  ],
  attendances: [ASTRID_PRESENT],
  proxyAuthorisations: [],
  bylaws: {
    proxyHolderEligibilityWidened: false,
    maxMembersPerProxyHolder: 1,
    storageOnlyVoteLimited: false,
    assistantEligibilityWidened: false,
  },
  votingRegister: {
    lines: [
      {
        memberPersonIds: ["person-astrid"],
        apartmentIds: ["apartment-1001"],
        jointlyHeld: false,
        presentMemberPersonIds: ["person-astrid"],
        proxyHolders: [],
        votePresent: true,
      },
    ],
    votesTotal: 1,
    votesPresent: 1,
    assistantsPresent: 0,
    presentWithoutMembership: [],
    proxyHoldersWithoutVote: [],
    storageOnlyVoteLimited: false,
  },
  notice: null,
};

/** The same meeting once the members have been summoned. */
const SUMMONED: Meeting = {
  ...ARRANGING,
  notice: {
    id: "notice-1",
    startsAt: "2027-05-20T17:00:00.000Z",
    place: "Föreningslokalen",
    digitalParticipation: null,
    issuedAt: "2027-04-20T09:00:00.000Z",
    issuedByPersonId: "person-board",
    deliveries: {
      pending: 0,
      sent: 1,
      failed: 1,
      mailNotConfigured: false,
      unreachedPersonIds: ["person-nils"],
    },
  },
};

/** And once it has been held. */
const HELD: Meeting = {
  ...SUMMONED,
  concludedAt: "2027-05-20T19:30:00.000Z",
};

beforeEach(() => {
  fetchMeetings.mockReset().mockResolvedValue({ ok: true, value: [SUMMARY] });
  fetchMeeting.mockReset().mockResolvedValue({ ok: true, value: ARRANGING });
  recordAttendance.mockReset();
  withdrawAttendance.mockReset();
  fetchBoardRegister
    .mockReset()
    .mockResolvedValue(structuredClone(REGISTER_PAGE));
});

/** Opens the meeting, which is what makes the six panels below appear. */
async function openTheMeeting(user: ReturnType<typeof userEvent.setup>) {
  // By the control rather than by the meeting's name, which also appears in the
  // "kind of meeting" select on the panel above it.
  const open = await screen.findByRole("button", { name: /^Öppna Ordinarie/ });
  await user.click(open);
  await screen.findByRole("heading", { name: "Röstlängden" });
}

describe("the general meeting screen", () => {
  it("offers nothing to an account without the capability", async () => {
    render(<MeetingsScreen viewer={viewer(["motions:handle"])} />);

    // The heading is the route's own and stays; the meetings are not read at
    // all, which is what says the screen is not quietly asking and hiding.
    await screen.findByRole("heading", { name: "Föreningsstämmor" });
    expect(fetchMeetings).not.toHaveBeenCalled();
    expect(
      screen.queryByRole("heading", { name: "Föreningens stämmor" }),
    ).toBeNull();
  });

  it("writes a name and an apartment beside every identifier", async () => {
    const user = userEvent.setup();
    render(<MeetingsScreen viewer={viewer(["meetings:manage"])} />);
    await openTheMeeting(user);

    // On the list of those present and on the register line, from the address
    // book rather than from the meetings API - which answers with identifiers
    // and no names at all.
    expect(screen.getAllByText("Astrid Lindqvist").length).toBeGreaterThan(0);
    expect(screen.getAllByText("1001").length).toBeGreaterThan(0);
    expect(fetchBoardRegister).toHaveBeenCalledWith(
      { filter: "all", page: 1, pageSize: 100 },
      expect.anything(),
    );
  });

  it("names an identifier the address book does not hold rather than leaving a blank", async () => {
    const user = userEvent.setup();
    fetchMeeting.mockResolvedValue({
      ok: true,
      value: {
        ...ARRANGING,
        attendances: [
          {
            ...ASTRID_PRESENT,
            id: "attendance-gone",
            personId: "person-purged",
          },
        ],
      },
    });

    render(<MeetingsScreen viewer={viewer(["meetings:manage"])} />);
    await openTheMeeting(user);

    /*
     * A service-tier row can name somebody the register no longer holds, and a
     * board reading an empty space cannot tell that from a screen that failed
     * to load. The identifier is printed beside the words that say what it is.
     */
    expect(
      screen.getAllByText("Finns inte i registret:").length,
    ).toBeGreaterThan(0);
    expect(screen.getAllByText("person-purged").length).toBeGreaterThan(0);
  });

  it("keeps the agenda editable until the members are summoned", async () => {
    const user = userEvent.setup();
    render(<MeetingsScreen viewer={viewer(["meetings:manage"])} />);
    await openTheMeeting(user);

    expect(
      screen.getByRole("button", { name: "Spara dagordningen" }),
    ).toBeTruthy();
  });

  it("makes the agenda a record once the notice has been issued", async () => {
    const user = userEvent.setup();
    fetchMeeting.mockResolvedValue({ ok: true, value: SUMMONED });

    render(<MeetingsScreen viewer={viewer(["meetings:manage"])} />);
    await openTheMeeting(user);

    /*
     * EFL 6 kap. 22 § with 25 §: from the moment the members are summoned, the
     * agenda is what they were summoned to deal with. The rule holding is said
     * in words rather than left as a disabled form, because a board reading
     * "you cannot change this" needs to know which of the two rules it is - one
     * of them is answered by arranging another meeting and the other is not.
     */
    expect(
      screen.queryByRole("button", { name: "Spara dagordningen" }),
    ).toBeNull();
    expect(
      screen.getByText(/Kallelsen till den h.r st.mman .r utf.rdad/u),
    ).toBeTruthy();
    // And the running order is still on the screen, as the record it now is -
    // on the agenda panel and again on the decisions panel below it.
    expect(screen.getAllByText("Val av styrelse").length).toBeGreaterThan(0);
  });

  it("names the members a notice did not reach, and never only a count", async () => {
    const user = userEvent.setup();
    fetchMeeting.mockResolvedValue({ ok: true, value: SUMMONED });

    render(<MeetingsScreen viewer={viewer(["meetings:manage"])} />);
    await openTheMeeting(user);

    /*
     * A notice is a summons the association owes every member (EFL 6 kap. 21 §),
     * so a member it could not reach is one the board has to call another way -
     * and a board told that one copy failed cannot ring anybody.
     */
    expect(screen.getByText(/Kallelsen n.dde inte/u)).toBeTruthy();
    expect(screen.getByText("Nils Lindqvist")).toBeTruthy();
  });

  it("offers no decision until the meeting has been recorded as held", async () => {
    const user = userEvent.setup();
    render(<MeetingsScreen viewer={viewer(["meetings:manage"])} />);
    await openTheMeeting(user);

    // The server refuses one with meeting-not-held, so the panel is a statement
    // rather than a form somebody fills in and is refused.
    expect(
      screen.queryByRole("button", { name: /^Anteckna beslutet/ }),
    ).toBeNull();
    expect(
      screen.getByText(/Ett beslut antecknas n.r st.mman har h.llits/u),
    ).toBeTruthy();
  });

  it("closes check-in and opens the decisions once the meeting is held", async () => {
    const user = userEvent.setup();
    fetchMeeting.mockResolvedValue({ ok: true, value: HELD });

    render(<MeetingsScreen viewer={viewer(["meetings:manage"])} />);
    await openTheMeeting(user);

    // The hinge of the whole screen, in both directions at once.
    expect(
      screen.getByRole("button", {
        name: "Anteckna beslutet om Val av styrelse",
      }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Anteckna som närvarande" }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Registrera fullmakten" }),
    ).toBeNull();
    // And the list of who was there is still on the screen, as the record it is.
    expect(screen.getAllByText("Astrid Lindqvist").length).toBeGreaterThan(0);
  });

  it("reads the meeting again after a check-in rather than believing the answer", async () => {
    const user = userEvent.setup();
    recordAttendance.mockResolvedValue({
      ok: true,
      value: {
        id: "attendance-2",
        personId: "person-nils",
        capacity: "ASSISTANT",
        mode: "IN_PERSON",
        onBehalfOfPersonId: "person-astrid",
        withdrawnAt: null,
      },
    });

    render(<MeetingsScreen viewer={viewer(["meetings:manage"])} />);
    await openTheMeeting(user);
    const readsBefore = fetchMeeting.mock.calls.length;

    await user.selectOptions(
      screen.getByLabelText("Vem som är närvarande"),
      "person-nils",
    );
    await user.click(
      screen.getByRole("button", { name: "Anteckna som närvarande" }),
    );

    /*
     * The write answers with one attendance line and never with the voting
     * register, which is derived from four things at once. Only a read can say
     * how many votes are now in the room.
     */
    await waitFor(() => {
      expect(fetchMeeting.mock.calls.length).toBeGreaterThan(readsBefore);
    });
  });

  it("reads the meeting again when a check-in is refused", async () => {
    const user = userEvent.setup();
    recordAttendance.mockResolvedValue({
      ok: false,
      failure: { status: 403, reason: "proxy-holder-holds-no-authority" },
    });

    render(<MeetingsScreen viewer={viewer(["meetings:manage"])} />);
    await openTheMeeting(user);
    const readsBefore = fetchMeeting.mock.calls.length;

    await user.selectOptions(
      screen.getByLabelText("Vem som är närvarande"),
      "person-nils",
    );
    await user.selectOptions(
      screen.getByLabelText("I vilken egenskap"),
      "PROXY_HOLDER",
    );
    await user.click(
      screen.getByRole("button", { name: "Anteckna som närvarande" }),
    );

    /*
     * The refusal that most needs the fresh answer. The board's next act is to
     * look at the authorities, and they have to be the ones the server has
     * rather than the ones the screen last saw.
     */
    await waitFor(() => {
      expect(fetchMeeting.mock.calls.length).toBeGreaterThan(readsBefore);
    });
    expect(
      screen.getByText(
        /Den h.r personen har ingen g.llande fullmakt f.r den h.r st.mman/u,
      ),
    ).toBeTruthy();
  });

  it("names the rule rather than answering a refusal with the shared sentence", async () => {
    const user = userEvent.setup();
    recordAttendance.mockResolvedValue({
      ok: false,
      failure: { status: 403, reason: "not-a-member-on-the-meeting-day" },
    });

    render(<MeetingsScreen viewer={viewer(["meetings:manage"])} />);
    await openTheMeeting(user);

    await user.selectOptions(
      screen.getByLabelText("Vem som är närvarande"),
      "person-nils",
    );
    await user.click(
      screen.getByRole("button", { name: "Anteckna som närvarande" }),
    );

    /*
     * A 403, and the shared branch would answer it with "your account is not
     * allowed to change this" - which is exactly the wrong thing to tell a board
     * member at a door. They are being told about the member register on a
     * stated day, not about a permission somebody could grant them.
     */
    await screen.findByText(
      /Medlemsf.rteckningen visar inte den h.r personen som medlem/u,
    );
  });

  it("drops a read the newer one overtook", async () => {
    const user = userEvent.setup();

    render(<MeetingsScreen viewer={viewer(["meetings:manage"])} />);
    await openTheMeeting(user);

    // The struck line as the later read has it, and the standing line as the
    // earlier one does. Both answers are well formed.
    const strickenLine: Attendance = {
      ...ASTRID_PRESENT,
      withdrawnAt: "2027-05-20T18:00:00.000Z",
    };
    const struck: Meeting = { ...ARRANGING, attendances: [strickenLine] };

    let overtaken = (): void => undefined;
    const slow = new Promise((resolve) => {
      overtaken = () => {
        resolve({ ok: true, value: ARRANGING });
      };
    });

    fetchMeeting
      .mockReturnValueOnce(slow)
      .mockResolvedValueOnce({ ok: true, value: struck });
    withdrawAttendance.mockResolvedValue({ ok: true, value: strickenLine });

    await user.click(screen.getByRole("button", { name: /^Stryk Astrid/ }));
    await user.click(screen.getByRole("button", { name: /^Stryk Astrid/ }));

    await screen.findByText("Strukna från förteckningen");

    // The overtaken answer arrives last and must not put the line back.
    overtaken();
    await waitFor(() => {
      expect(screen.getByText("Strukna från förteckningen")).toBeTruthy();
    });
  });

  it("keeps the meeting on screen when a re-read fails", async () => {
    const user = userEvent.setup();
    render(<MeetingsScreen viewer={viewer(["meetings:manage"])} />);
    await openTheMeeting(user);

    fetchMeeting.mockResolvedValue({
      ok: false,
      failure: { status: 500, reason: "unexpected" },
    });
    withdrawAttendance.mockResolvedValue({ ok: true, value: ASTRID_PRESENT });

    await user.click(screen.getByRole("button", { name: /^Stryk Astrid/ }));

    /*
     * The panels must not empty under somebody standing at a door. The last
     * thing the server said is still a true picture of a moment, and the notice
     * says the read failed.
     */
    await screen.findByText("Stämmorna kunde inte läsas.");
    expect(screen.getByRole("heading", { name: "Röstlängden" })).toBeTruthy();
    expect(screen.getAllByText("Astrid Lindqvist").length).toBeGreaterThan(0);
  });

  it("works with identifiers when the address book cannot be read", async () => {
    const user = userEvent.setup();
    fetchBoardRegister.mockRejectedValue(new Error("no"));

    render(<MeetingsScreen viewer={viewer(["meetings:manage"])} />);
    await openTheMeeting(user);

    // Said once for the screen rather than on each of the six panels, and the
    // meeting is still workable: every identifier renders as itself.
    expect(screen.getByText(/Adressboken kunde inte l.sas/u)).toBeTruthy();
    expect(screen.getAllByText("person-astrid").length).toBeGreaterThan(0);
  });
});

import { describe, expect, it } from "vitest";

import { dateColumnOf, parseLocalDay } from "../bookings/stockholm-calendar";
import type { ResolvedRegisterEvent } from "../registers/membership-periods";
import {
  type RollAttendance,
  type RollHolding,
  type RollProxyAuthorisation,
  votingRegister,
} from "./voting-register";

/**
 * The voting register (rostlangd), exercised without a database.
 *
 * Four of these assertions are the statute and not a preference, and each of
 * them is a rule a mistake here would break silently - a register is read once, in a
 * room, by people who cannot check it against the register:
 *
 *   A member holding two apartments has one vote (EFL 6 kap. 3 § with BRL 9 kap.
 *   14 § 1: the vote belongs to the membership).
 *
 *   Members holding one bostadsratt jointly have one vote between them (BRL
 *   9 kap. 14 § 1, second sentence).
 *
 *   A bitrade has no vote (EFL 6 kap. 7 § gives it the right to speak).
 *
 *   An ombud's authority is measured against the meeting day and not against the
 *   day it was registered (EFL 6 kap. 4 § andra stycket).
 */

const day = (text: string): Date => {
  const parsed = parseLocalDay(text);
  if (parsed === null) {
    throw new Error(`${text} is not a calendar date.`);
  }
  return dateColumnOf(parsed);
};

const MEETING_DAY = day("2027-05-12");

let sequence = 0;

/** One archive row, with the fields the voting register does not read. */
function event(input: {
  personId: string;
  apartmentId: string | null;
  eventType: "ENTRY" | "EXIT";
  eventOn: string;
}): ResolvedRegisterEvent {
  sequence += 1;
  return {
    id: `event-${String(sequence)}`,
    personId: input.personId,
    apartmentId: input.apartmentId,
    eventType: input.eventType,
    eventOn: day(input.eventOn),
    recordedFirstName: "Namn",
    recordedLastName: "Namnsson",
    recordedPostalStreet: null,
    recordedPostalCode: null,
    recordedPostalCity: null,
    correctsEntryId: null,
    corrected: false,
    createdAt: new Date(`${input.eventOn}T09:00:00.000Z`),
  };
}

const entry = (
  personId: string,
  apartmentId: string | null,
  eventOn = "2020-01-01",
): ResolvedRegisterEvent =>
  event({ personId, apartmentId, eventType: "ENTRY", eventOn });

const exit = (
  personId: string,
  apartmentId: string | null,
  eventOn: string,
): ResolvedRegisterEvent =>
  event({ personId, apartmentId, eventType: "EXIT", eventOn });

const present = (
  personId: string,
  capacity: RollAttendance["capacity"],
): RollAttendance => ({ personId, capacity, withdrawnAt: null });

const authority = (
  memberPersonId: string,
  proxyHolderPersonId: string,
  authorisedOn = "2027-04-20",
): RollProxyAuthorisation => ({
  memberPersonId,
  proxyHolderPersonId,
  authorisedOn: day(authorisedOn),
  withdrawnAt: null,
});

const holds = (personId: string, apartmentId: string): RollHolding => ({
  personId,
  apartmentId,
});

/**
 * Draws a register, with the holdings defaulted from the archive's own entries.
 *
 * The register and the residencies agree in every ordinary case - a member who
 * entered on an apartment lives there as a MEMBER - so deriving the default from
 * the events keeps each test to the one fact it is about. The tests that turn on
 * the two sources disagreeing pass `holdings` explicitly, which is the whole
 * point of the parameter.
 */
function holdingsImpliedBy(
  events: readonly ResolvedRegisterEvent[],
): RollHolding[] {
  const implied: RollHolding[] = [];
  for (const row of events) {
    if (row.eventType === "ENTRY" && row.apartmentId !== null) {
      implied.push(holds(row.personId, row.apartmentId));
    }
  }
  return implied;
}

function roll(input: {
  events?: readonly ResolvedRegisterEvent[];
  holdings?: readonly RollHolding[];
  attendances?: readonly RollAttendance[];
  proxyAuthorisations?: readonly RollProxyAuthorisation[];
  meetingDay?: Date;
  storageOnlyVoteLimited?: boolean;
}) {
  const events = input.events ?? [];
  return votingRegister({
    events,
    meetingDay: input.meetingDay ?? MEETING_DAY,
    holdings: input.holdings ?? holdingsImpliedBy(events),
    attendances: input.attendances ?? [],
    proxyAuthorisations: input.proxyAuthorisations ?? [],
    storageOnlyVoteLimited: input.storageOnlyVoteLimited ?? false,
  });
}

describe("one vote per membership", () => {
  it("gives a member holding two apartments one vote and not two", () => {
    /*
     * The rule the earlier draft of this platform's plan had backwards. EFL
     * 6 kap. 3 § gives the vote to the member, and BRL 9 kap. 14 § 1 permits a
     * bylaws deviation only to limit a storage-only holding - so nothing
     * anywhere makes a second apartment a second vote.
     *
     * Two lines here would be visible in the room as a household voting twice,
     * which is the kind of defect a meeting cannot undo afterwards.
     */
    const result = roll({
      events: [entry("maja", "apartment-1"), entry("maja", "apartment-2")],
    });

    expect(result.votesTotal).toBe(1);
    expect(result.lines).toHaveLength(1);
    expect(result.lines[0]?.memberPersonIds).toEqual(["maja"]);
    // Both holdings are named on the one line, so the chair can see what it
    // covers rather than having to trust the count.
    expect(result.lines[0]?.apartmentIds).toEqual([
      "apartment-1",
      "apartment-2",
    ]);
    expect(result.lines[0]?.jointlyHeld).toBe(false);
  });

  it("gives joint holders of one bostadsratt one vote between them", () => {
    /*
     * BRL 9 kap. 14 § 1, second sentence, and unconditional: unlike the storage
     * limitation in the same paragraph it does not depend on the bylaws.
     */
    const result = roll({
      events: [entry("maja", "apartment-1"), entry("erik", "apartment-1")],
    });

    expect(result.votesTotal).toBe(1);
    expect(result.lines[0]?.memberPersonIds).toEqual(["erik", "maja"]);
    expect(result.lines[0]?.jointlyHeld).toBe(true);
  });

  it("merges a chain of joint holdings rather than splitting a vote", () => {
    /*
     * Maja holds one apartment with Erik and another with Nils. She cannot have
     * one vote with each of them without having two, which the first rule
     * forbids, so the three memberships are one vote and the line names all of
     * them - which is what lets the meeting change the voting register under EFL
     * 27 § if it reads the paragraph differently.
     */
    const result = roll({
      events: [
        entry("maja", "apartment-1"),
        entry("erik", "apartment-1"),
        entry("maja", "apartment-2"),
        entry("nils", "apartment-2"),
      ],
    });

    expect(result.votesTotal).toBe(1);
    expect(result.lines[0]?.memberPersonIds).toEqual(["erik", "maja", "nils"]);
    expect(result.lines[0]?.apartmentIds).toEqual([
      "apartment-1",
      "apartment-2",
    ]);
  });

  it("keeps two members in two apartments as two votes", () => {
    // The control for the two rules above: merging is what a shared apartment
    // does, and a test that only asserted merges would pass against a register that
    // merged everything.
    const result = roll({
      events: [entry("maja", "apartment-1"), entry("erik", "apartment-2")],
    });

    expect(result.votesTotal).toBe(2);
    expect(result.lines.map((line) => line.memberPersonIds)).toEqual([
      ["erik"],
      ["maja"],
    ]);
  });

  it("gives a membership with no apartment its vote anyway", () => {
    // The register allows an entry without an apartment - one can predate the
    // apartment being recorded - and the vote belongs to the membership, so
    // dropping the line would take somebody's vote away over a gap in the
    // archive.
    const result = roll({ events: [entry("maja", null)], holdings: [] });

    expect(result.votesTotal).toBe(1);
    expect(result.lines[0]?.apartmentIds).toEqual([]);
  });
});

describe("membership on the meeting day", () => {
  it("leaves out somebody whose membership ended before the meeting", () => {
    const result = roll({
      events: [
        entry("maja", "apartment-1", "2020-01-01"),
        exit("maja", "apartment-1", "2027-04-30"),
      ],
    });

    expect(result.votesTotal).toBe(0);
  });

  it("counts a membership that ends after the meeting", () => {
    const result = roll({
      events: [
        entry("maja", "apartment-1", "2020-01-01"),
        exit("maja", "apartment-1", "2027-06-01"),
      ],
    });

    expect(result.votesTotal).toBe(1);
  });

  it("treats the exit day itself as a day without a vote", () => {
    // The move-out convention every other reader of a dated close in this
    // codebase follows: the closing date is the first day not held. A meeting on
    // the day a membership ended is a meeting they have no vote at.
    const result = roll({
      events: [
        entry("maja", "apartment-1", "2020-01-01"),
        exit("maja", "apartment-1", "2027-05-12"),
      ],
    });

    expect(result.votesTotal).toBe(0);
  });

  it("leaves out a membership that began after the meeting day", () => {
    const result = roll({
      events: [entry("maja", "apartment-1", "2027-06-01")],
    });

    expect(result.votesTotal).toBe(0);
  });

  it("does not join a seller to their buyer when the archive keeps the entry open", () => {
    /*
     * The case that decides where the holdings come from, and the one the
     * archive alone gets wrong.
     *
     * Maja held two apartments and sold one to Erik. `MoveService` writes an
     * EXIT row only when a person's *last* tenant-ownership ends - a member who
     * sells one of two is still a member, and an EXIT could never be taken back
     * - so the archive here holds two open ENTRY rows for Maja and a third for
     * Erik on the apartment she sold. Merging on that would put Maja and Erik on
     * one line with one vote between them, which is a household losing its vote
     * on the strength of a row nobody wrote wrongly.
     *
     * The residencies say what actually happened, and they are passed as such.
     */
    const result = roll({
      events: [
        entry("maja", "apartment-1", "2020-01-01"),
        entry("maja", "apartment-2", "2020-01-01"),
        entry("erik", "apartment-1", "2027-04-01"),
      ],
      holdings: [holds("maja", "apartment-2"), holds("erik", "apartment-1")],
    });

    expect(result.votesTotal).toBe(2);
    const maja = result.lines.find((line) =>
      line.memberPersonIds.includes("maja"),
    );
    expect(maja?.memberPersonIds).toEqual(["maja"]);
    expect(maja?.apartmentIds).toEqual(["apartment-2"]);
  });

  it("keeps the vote of a membership no residency covers", () => {
    /*
     * What a purged residency behind a long-past meeting looks like: the archive
     * still says they were a member on the day, and nothing says which apartment
     * they held. The vote stands, because EFL 6 kap. 3 § gives it to the member
     * and not to the holding, and the line merges with nobody.
     */
    const result = roll({
      events: [entry("maja", "apartment-1", "2020-01-01")],
      holdings: [],
    });

    expect(result.votesTotal).toBe(1);
    expect(result.lines[0]?.apartmentIds).toEqual([]);
  });
});

describe("who is exercising a vote", () => {
  const twoHouseholds = [
    entry("maja", "apartment-1"),
    entry("erik", "apartment-2"),
  ];

  it("counts a member present themselves", () => {
    const result = roll({
      events: twoHouseholds,
      attendances: [present("maja", "MEMBER")],
    });

    expect(result.votesPresent).toBe(1);
    expect(result.votesTotal).toBe(2);
  });

  it("gives a bitrade no vote", () => {
    /*
     * EFL 6 kap. 7 § lets a member or an ombud bring at most one bitrade, who
     * may speak at the meeting. That is the whole of what it grants. A bitrade
     * counted as a vote would be a vote nobody in the room believes they cast.
     *
     * The bitrade here is a member of the association in their own right, which
     * is the case that would slip past a check written against the register
     * rather than against the capacity: Erik holds apartment-2 and is present
     * only as Maja's bitrade, so his own vote is not in the room either.
     */
    const result = roll({
      events: twoHouseholds,
      attendances: [present("erik", "ASSISTANT")],
    });

    expect(result.votesPresent).toBe(0);
    expect(result.assistantsPresent).toBe(1);
    expect(
      result.lines.find((line) => line.memberPersonIds.includes("erik"))
        ?.votePresent,
    ).toBe(false);
  });

  it("counts a vote once when a joint holder is present", () => {
    const result = roll({
      events: [entry("maja", "apartment-1"), entry("erik", "apartment-1")],
      attendances: [present("maja", "MEMBER"), present("erik", "MEMBER")],
    });

    expect(result.votesTotal).toBe(1);
    expect(result.votesPresent).toBe(1);
    expect(result.lines[0]?.presentMemberPersonIds).toEqual(["erik", "maja"]);
  });

  it("counts a member and the neighbour's vote they carry as two", () => {
    // One body, two lines, two votes: the ordinary case for somebody arriving
    // with a fullmakt, and the reason the capacity belongs to the line rather
    // than to the person.
    const result = roll({
      events: twoHouseholds,
      attendances: [present("maja", "MEMBER"), present("maja", "PROXY_HOLDER")],
      proxyAuthorisations: [authority("erik", "maja")],
    });

    expect(result.votesPresent).toBe(2);
    expect(result.proxyHoldersWithoutVote).toEqual([]);
  });

  it("does not count an ombud whose member turned up", () => {
    /*
     * EFL 6 kap. 4 § has the ombud act for "en medlem som inte ar personligen
     * narvarande", so a member who came exercises their own right and the
     * authority has nothing left to do. Counting both would put two
     * representatives on a line that carries one vote.
     */
    const result = roll({
      events: twoHouseholds,
      attendances: [present("erik", "MEMBER"), present("maja", "PROXY_HOLDER")],
      proxyAuthorisations: [authority("erik", "maja")],
    });

    const erik = result.lines.find((line) =>
      line.memberPersonIds.includes("erik"),
    );
    expect(erik?.proxyHolders).toEqual([]);
    expect(result.votesPresent).toBe(1);
    expect(result.proxyHoldersWithoutVote).toEqual(["maja"]);
  });

  it("refuses an authority that has run out on the meeting day", () => {
    /*
     * EFL 6 kap. 4 § andra stycket: a fullmakt holds for at most one year from
     * the day it was issued. Asked here rather than trusted from the
     * registration, because the meeting day can be moved after the board checked
     * it - and a register that trusted the write would seat an ombud whose authority
     * had expired in between.
     */
    const result = roll({
      events: twoHouseholds,
      attendances: [present("maja", "PROXY_HOLDER")],
      proxyAuthorisations: [authority("erik", "maja", "2026-05-11")],
    });

    expect(result.votesPresent).toBe(0);
    expect(result.proxyHoldersWithoutVote).toEqual(["maja"]);
  });

  it("accepts an authority dated exactly a year before the meeting", () => {
    // The far edge of the same rule, and the control for it: a year to the day
    // still holds, so a test that only asserted the refusal would pass against
    // an implementation that refused everything older than a month.
    const result = roll({
      events: twoHouseholds,
      attendances: [present("maja", "PROXY_HOLDER")],
      proxyAuthorisations: [authority("erik", "maja", "2026-05-12")],
    });

    expect(result.votesPresent).toBe(1);
  });

  it("ignores an authority that was taken back", () => {
    const result = roll({
      events: twoHouseholds,
      attendances: [present("maja", "PROXY_HOLDER")],
      proxyAuthorisations: [
        { ...authority("erik", "maja"), withdrawnAt: new Date() },
      ],
    });

    expect(result.votesPresent).toBe(0);
  });

  it("ignores a line the board struck off the list", () => {
    const result = roll({
      events: twoHouseholds,
      attendances: [
        { personId: "maja", capacity: "MEMBER", withdrawnAt: new Date() },
      ],
    });

    expect(result.votesPresent).toBe(0);
  });

  it("reports somebody present as a member whom the register does not hold", () => {
    /*
     * Check-in happens before the meeting and the register keeps moving until
     * the day itself, so this is what a transfer completed in between looks
     * like. Reported rather than dropped: a name on the list at the door with no
     * line here is exactly what the chair has to be told about.
     */
    const result = roll({
      events: twoHouseholds,
      attendances: [present("nils", "MEMBER")],
    });

    expect(result.votesPresent).toBe(0);
    expect(result.presentWithoutMembership).toEqual(["nils"]);
  });
});

describe("the bylaws clause the platform does not apply", () => {
  it("reports the storage limitation rather than acting on it", () => {
    /*
     * BRL 9 kap. 14 § 1 permits the bylaws to limit the vote of a member holding
     * nothing but a garage, a store or other storage space. The clause turns on
     * what a space is used for and nothing in this platform records that, so the
     * roll states that the clause stands and the meeting applies it - which is
     * where EFL 6 kap. 27 § puts the decision in any case.
     *
     * Asserted as a vote that is still counted, because the failure to guard
     * against is a register that quietly subtracted one on a guess.
     */
    const result = roll({
      events: [entry("maja", "apartment-1")],
      storageOnlyVoteLimited: true,
    });

    expect(result.storageOnlyVoteLimited).toBe(true);
    expect(result.votesTotal).toBe(1);
  });
});

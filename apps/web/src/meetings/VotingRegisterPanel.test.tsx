import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import "../i18n";
import type { Meeting, VotingRegister } from "../api/meetings";
import type { MeetingPeople, MeetingPerson } from "./use-meeting-people";
import { VotingRegisterPanel } from "./VotingRegisterPanel";

/**
 * The voting register as a board reads it out at a meeting.
 *
 * How the register is derived is decided on the server and tested there against
 * a real member register. What this file pins down is what the screen says about
 * the answer, and every assertion here is about a sentence a chair would
 * otherwise have to infer.
 *
 * That one vote shared by two members says so in words. Two names on one row is
 * exactly what a reader would otherwise count as two votes, and BRL 9 kap. 14 §
 * 1 gives joint holders of one bostadsratt one vote between them.
 *
 * That the count of votes present is not offered as a majority basis. EFL
 * measures an ordinary majority against the votes cast, and somebody present who
 * does not vote has cast none.
 *
 * That the two lists which exist so nobody is dropped in silence are rendered,
 * with the four readings of the second one rather than a guess at which it is.
 *
 * That the storage clause is reported and never applied.
 *
 * That there is no control on the panel at all. The register is derived when it
 * is read and never stored, so there is nothing here for anybody to write.
 */

const PEOPLE: readonly MeetingPerson[] = [
  {
    personId: "person-astrid",
    name: "Astrid Lindqvist",
    apartmentNumbers: ["1001"],
    protectedPersonalData: false,
  },
  {
    personId: "person-nils",
    name: "Nils Lindqvist",
    apartmentNumbers: ["1001"],
    protectedPersonalData: false,
  },
  {
    personId: "person-ombud",
    name: "Olle Ombudsson",
    apartmentNumbers: ["1002"],
    protectedPersonalData: false,
  },
];

const people: MeetingPeople = {
  ready: true,
  failed: false,
  everyone: PEOPLE,
  find: (personId) => PEOPLE.find((p) => p.personId === personId) ?? null,
};

function meetingWith(register: VotingRegister): Meeting {
  return {
    id: "meeting-1",
    kind: "ORDINARY",
    heldOn: "2027-05-20",
    concludedAt: null,
    agendaItemCount: 0,
    agenda: [],
    attendances: [],
    proxyAuthorisations: [],
    bylaws: {
      proxyHolderEligibilityWidened: false,
      maxMembersPerProxyHolder: 1,
      storageOnlyVoteLimited: false,
      assistantEligibilityWidened: false,
    },
    votingRegister: register,
    notice: null,
  };
}

const EMPTY: VotingRegister = {
  lines: [],
  votesTotal: 0,
  votesPresent: 0,
  assistantsPresent: 0,
  presentWithoutMembership: [],
  proxyHoldersWithoutVote: [],
  storageOnlyVoteLimited: false,
};

describe("the voting register", () => {
  it("says in words that a jointly held vote is one vote", () => {
    render(
      <VotingRegisterPanel
        meeting={meetingWith({
          ...EMPTY,
          lines: [
            {
              memberPersonIds: ["person-astrid", "person-nils"],
              apartmentIds: ["apartment-1001"],
              jointlyHeld: true,
              presentMemberPersonIds: ["person-astrid"],
              proxyHolders: [],
              votePresent: true,
            },
          ],
          votesTotal: 1,
          votesPresent: 1,
        })}
        people={people}
      />,
    );

    expect(screen.getByText("Astrid Lindqvist")).toBeTruthy();
    expect(screen.getByText("Nils Lindqvist")).toBeTruthy();
    expect(screen.getByText(/En r.st, innehavd gemensamt/u)).toBeTruthy();
  });

  it("does not offer the votes present as a majority basis", () => {
    render(
      <VotingRegisterPanel
        meeting={meetingWith({ ...EMPTY, votesTotal: 12, votesPresent: 7 })}
        people={people}
      />,
    );

    // The figure is there and so is the sentence that says what it is not.
    expect(screen.getByText("7")).toBeTruthy();
    expect(screen.getByText(/inte det en majoritet m.ts mot/u)).toBeTruthy();
  });

  it("names a member present without a membership on the day", () => {
    render(
      <VotingRegisterPanel
        meeting={meetingWith({
          ...EMPTY,
          presentWithoutMembership: ["person-nils"],
        })}
        people={people}
      />,
    );

    /*
     * Not dropped in silence, which is the whole point of the field: check-in
     * happens before the meeting and the register keeps moving until the day
     * itself, so a transfer completed in between looks like this - and a chair
     * with a name at the door and no line for it has been told nothing.
     */
    expect(
      screen.getByText("Närvarande som medlemmar, utan medlemskap den dagen"),
    ).toBeTruthy();
    expect(screen.getByText("Nils Lindqvist")).toBeTruthy();
  });

  it("gives all four readings of a proxy holder exercising nothing", () => {
    render(
      <VotingRegisterPanel
        meeting={meetingWith({
          ...EMPTY,
          proxyHoldersWithoutVote: ["person-ombud"],
        })}
        people={people}
      />,
    );

    /*
     * The platform cannot tell the four apart, and one of them is the case where
     * nothing at all is wrong - the member turned up and is exercising their own
     * right. Picking one would send a board looking for a problem that is not
     * there.
     */
    const explanation = screen.getByText(/Fyra saker ser ut s. h.r/u);
    expect(explanation.textContent).toContain("återkallad");
    expect(explanation.textContent).toContain("äldre än ett år");
    expect(explanation.textContent).toContain("inte längre medlem");
    expect(explanation.textContent).toContain("ingenting är fel");
    expect(screen.getByText("Olle Ombudsson")).toBeTruthy();
  });

  it("reports the storage clause and applies nothing", () => {
    render(
      <VotingRegisterPanel
        meeting={meetingWith({
          ...EMPTY,
          storageOnlyVoteLimited: true,
          votesTotal: 3,
        })}
        people={people}
      />,
    );

    const notice = screen.getByText(/Stadgarna begr.nsar r.str.tten/u);
    expect(notice.textContent).toContain("tillämpas inte här");
    // EFL 6 kap. 27 § puts the decision at the meeting, which is what the
    // sentence has to say rather than leaving the board to assume a count was
    // adjusted for it.
    expect(notice.textContent).toContain("stämman tillämpar den");
  });

  it("says a vote stands where no tenant-ownership covers the day", () => {
    render(
      <VotingRegisterPanel
        meeting={meetingWith({
          ...EMPTY,
          lines: [
            {
              memberPersonIds: ["person-astrid"],
              apartmentIds: [],
              jointlyHeld: false,
              presentMemberPersonIds: [],
              proxyHolders: [],
              votePresent: false,
            },
          ],
          votesTotal: 1,
        })}
        people={people}
      />,
    );

    // EFL 6 kap. 3 § gives the vote to the member and not to the holding, so the
    // absence is a sentence rather than a blank.
    expect(screen.getByText(/Ingen bostadsr.tt t.cker/u)).toBeTruthy();
    expect(screen.getByText("Rösten frånvarande")).toBeTruthy();
  });

  it("offers no control at all", () => {
    render(
      <VotingRegisterPanel
        meeting={meetingWith({ ...EMPTY, votesTotal: 4, votesPresent: 2 })}
        people={people}
      />,
    );

    // Nothing here is written. The register is derived every time it is read,
    // and what changes a line is a check-in or an authority on the panels above.
    expect(screen.queryAllByRole("button")).toHaveLength(0);
    expect(screen.queryAllByRole("textbox")).toHaveLength(0);
  });
});

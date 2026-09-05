import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import "../i18n";
import type { Meeting } from "../api/meetings";
import { MeetingDecisionsPanel } from "./MeetingDecisionsPanel";
import type { MeetingPeople, MeetingPerson } from "./use-meeting-people";

/**
 * Minuting what the meeting decided.
 *
 * That the counts are transcribed and never tallied. The form takes three
 * figures because an ordinary majority is measured against the votes cast, and
 * what a decision needed is the chair's to state - so nothing here counts
 * anything and nothing here casts a vote.
 *
 * That the counts are not checked against the votes present either. A count
 * above that figure is possible on a register the meeting itself resolved to
 * change, which is exactly what EFL 6 kap. 27 § allows - so a screen refusing it
 * would be enforcing a rule the statute does not have against the minutes of a
 * meeting that has already happened.
 *
 * That a figure typed in exponent notation is read as the number it is. A number
 * input accepts "1e2" and `Number.parseInt` reads it as 1, which would put one
 * vote in the association's copy of the protokoll where a hundred were cast. A
 * field left blank is a different thing and is refused: `Number("")` is 0, and a
 * blank is a count nobody has entered rather than a count of nothing.
 *
 * That correcting a mis-keyed count is editing what is there rather than
 * entering it again, because that is what writing the row again actually is.
 */

const recordDecision = vi.fn();

vi.mock("../api/meetings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/meetings")>()),
  recordDecision: (input: unknown) => recordDecision(input),
}));

const PEOPLE: readonly MeetingPerson[] = [
  {
    personId: "person-board",
    name: "Bo Bergman",
    apartmentNumbers: [],
    protectedPersonalData: false,
  },
];

const people: MeetingPeople = {
  ready: true,
  failed: false,
  everyone: PEOPLE,
  find: (personId) => PEOPLE.find((p) => p.personId === personId) ?? null,
};

function meeting(overrides: Partial<Meeting> = {}): Meeting {
  return {
    id: "meeting-1",
    kind: "ORDINARY",
    heldOn: "2027-05-20",
    concludedAt: "2027-05-20T19:30:00.000Z",
    agendaItemCount: 1,
    agenda: [
      { id: "item-1", position: 1, title: "Val av styrelse", decision: null },
    ],
    attendances: [],
    proxyAuthorisations: [],
    bylaws: {
      proxyHolderEligibilityWidened: false,
      maxMembersPerProxyHolder: 1,
      storageOnlyVoteLimited: false,
      assistantEligibilityWidened: false,
    },
    votingRegister: {
      lines: [],
      votesTotal: 8,
      votesPresent: 5,
      assistantsPresent: 0,
      presentWithoutMembership: [],
      proxyHoldersWithoutVote: [],
      storageOnlyVoteLimited: false,
    },
    notice: null,
    ...overrides,
  };
}

beforeEach(() => {
  recordDecision.mockReset().mockResolvedValue({
    ok: true,
    value: {
      id: "item-1",
      position: 1,
      title: "Val av styrelse",
      decision: null,
    },
  });
});

describe("what the meeting decided", () => {
  it("sends the counts the chair declared", async () => {
    const user = userEvent.setup();
    const onChanged = vi.fn();

    render(
      <MeetingDecisionsPanel
        meeting={meeting()}
        people={people}
        onChanged={onChanged}
      />,
    );

    await user.type(screen.getByLabelText("För"), "4");
    await user.type(screen.getByLabelText("Mot"), "1");
    await user.type(screen.getByLabelText("Avstår"), "0");
    await user.click(screen.getByLabelText("Togs med sluten omröstning"));
    await user.click(
      screen.getByRole("button", {
        name: "Anteckna beslutet om Val av styrelse",
      }),
    );

    await waitFor(() => {
      expect(recordDecision).toHaveBeenCalledWith({
        id: "meeting-1",
        agendaItemId: "item-1",
        values: {
          outcome: "CARRIED",
          votesFor: 4,
          votesAgainst: 1,
          votesAbstaining: 0,
          closedBallot: true,
        },
      });
    });
    expect(onChanged).toHaveBeenCalled();
  });

  it("accepts a count above the votes present", async () => {
    const user = userEvent.setup();

    // The register carries five votes present. The meeting may have resolved to
    // change the register when it approved it (EFL 6 kap. 27 §), so the screen
    // has no business refusing the chair's own figure.
    render(
      <MeetingDecisionsPanel
        meeting={meeting()}
        people={people}
        onChanged={() => undefined}
      />,
    );

    await user.type(screen.getByLabelText("För"), "9");
    await user.type(screen.getByLabelText("Mot"), "0");
    await user.type(screen.getByLabelText("Avstår"), "0");
    await user.click(
      screen.getByRole("button", {
        name: "Anteckna beslutet om Val av styrelse",
      }),
    );

    await waitFor(() => {
      expect(recordDecision).toHaveBeenCalledWith(
        expect.objectContaining({
          values: expect.objectContaining({ votesFor: 9 }),
        }),
      );
    });
  });

  it("reads a figure in exponent notation as the number it is", async () => {
    const user = userEvent.setup();

    render(
      <MeetingDecisionsPanel
        meeting={meeting()}
        people={people}
        onChanged={() => undefined}
      />,
    );

    /*
     * A number input accepts exponent notation, so this is a value the field can
     * actually hold. `Number.parseInt("1e2")` is 1, which would put one vote in
     * the association's copy of the protokoll where a hundred were cast; `Number`
     * reads it as the hundred it says. Break the conversion and this fails.
     */
    await user.type(screen.getByLabelText("För"), "1e2");
    await user.type(screen.getByLabelText("Mot"), "0");
    await user.type(screen.getByLabelText("Avstår"), "0");
    await user.click(
      screen.getByRole("button", {
        name: "Anteckna beslutet om Val av styrelse",
      }),
    );

    await waitFor(() => {
      expect(recordDecision).toHaveBeenCalledWith(
        expect.objectContaining({
          values: expect.objectContaining({ votesFor: 100 }),
        }),
      );
    });
  });

  it("will not send a decision with a count left blank", async () => {
    const user = userEvent.setup();

    render(
      <MeetingDecisionsPanel
        meeting={meeting()}
        people={people}
        onChanged={() => undefined}
      />,
    );

    /*
     * `Number("")` is 0 and a blank field is not a count of nothing - it is a
     * figure the board has not entered yet. Sending it would minute a tally
     * nobody declared.
     */
    await user.type(screen.getByLabelText("För"), "4");
    await user.type(screen.getByLabelText("Mot"), "1");

    const record = screen.getByRole("button", {
      name: "Anteckna beslutet om Val av styrelse",
    });
    expect(record.hasAttribute("disabled")).toBe(true);
    await user.click(record);
    expect(recordDecision).not.toHaveBeenCalled();
  });

  it("opens the form on the decision already recorded", () => {
    render(
      <MeetingDecisionsPanel
        meeting={meeting({
          agenda: [
            {
              id: "item-1",
              position: 1,
              title: "Val av styrelse",
              decision: {
                outcome: "REJECTED",
                votesFor: 2,
                votesAgainst: 6,
                votesAbstaining: 1,
                closedBallot: false,
                recordedByPersonId: "person-board",
                recordedAt: "2027-05-20T19:45:00.000Z",
              },
            },
          ],
        })}
        people={people}
        onChanged={() => undefined}
      />,
    );

    // Correcting a mis-keyed count writes the same row again, so a board doing
    // that is editing four figures rather than entering them from nothing.
    expect(screen.getByLabelText<HTMLInputElement>("För").value).toBe("2");
    expect(screen.getByLabelText<HTMLInputElement>("Mot").value).toBe("6");
    expect(screen.getByLabelText<HTMLInputElement>("Avstår").value).toBe("1");
    expect(screen.getByLabelText<HTMLSelectElement>("Utgång").value).toBe(
      "REJECTED",
    );
    // And who recorded it, which is what the audit log answers for.
    expect(screen.getByText(/Antecknat av/u).textContent).toContain(
      "Bo Bergman",
    );
  });

  it("is a statement while the meeting has not been recorded as held", () => {
    render(
      <MeetingDecisionsPanel
        meeting={meeting({ concludedAt: null })}
        people={people}
        onChanged={() => undefined}
      />,
    );

    // The server refuses a decision with meeting-not-held, so a form here would
    // be one the board fills in and is refused.
    expect(screen.queryByLabelText("För")).toBeNull();
    expect(
      screen.getByText(/Ett beslut antecknas n.r st.mman har h.llits/u),
    ).toBeTruthy();
    // The agenda is still listed, so the board can see what is waiting.
    expect(screen.getByText("Val av styrelse")).toBeTruthy();
  });
});

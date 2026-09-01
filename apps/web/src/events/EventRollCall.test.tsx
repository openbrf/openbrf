import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import "../i18n";
import type { RollCall } from "../api/events";
import { EventRollCall } from "./EventRollCall";

/**
 * Who has put their name down for one date.
 *
 * The three shapes an attendee arrives in are the point of this file. A resident
 * is named. A person with protected personal data (skyddade personuppgifter) is a
 * place and never a name - the server sends no name, and this is the screen it
 * would have to appear on, so the row's whole text is asserted rather than merely
 * the absence of one. Somebody the register no longer holds is a place too,
 * because a sign-up outlives the person record a purge has reached.
 *
 * The rest is the count and the rows being one answer: a withdrawal reads the
 * list again, refused or not, so the places taken and the rows below cannot
 * disagree.
 */

const fetchRollCall = vi.fn();
const withdrawSignupForBoard = vi.fn();

vi.mock("../api/events", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/events")>()),
  fetchRollCall: (id: string) => fetchRollCall(id),
  withdrawSignupForBoard: (id: string) => withdrawSignupForBoard(id),
}));

const BASE: RollCall = {
  occurrenceId: "occurrence-april",
  eventId: "event-cleaning",
  title: "Städdag",
  startsAt: "2026-04-18T08:00:00.000Z",
  endsAt: "2026-04-18T11:00:00.000Z",
  on: "2026-04-18",
  cancelledAt: null,
  capacity: 20,
  placesTaken: 3,
  entries: [
    {
      signupId: "signup-elin",
      attendee: {
        kind: "resident",
        personId: "person-elin",
        name: "Elin Hammar",
      },
      signedUpAt: "2026-04-02T09:00:00.000Z",
      withdrawnAt: null,
    },
    {
      signupId: "signup-protected",
      attendee: { kind: "protected", personId: "person-protected" },
      signedUpAt: "2026-04-03T09:00:00.000Z",
      withdrawnAt: null,
    },
    {
      signupId: "signup-gone",
      attendee: { kind: "unknown" },
      signedUpAt: "2026-04-04T09:00:00.000Z",
      withdrawnAt: null,
    },
  ],
};

beforeEach(() => {
  fetchRollCall.mockReset().mockResolvedValue({ ok: true, value: BASE });
  withdrawSignupForBoard.mockReset().mockResolvedValue({
    ok: true,
    value: { ...BASE, placesTaken: 2 },
  });
});

/** Renders the list and waits for the read to land. */
async function open(): Promise<void> {
  render(<EventRollCall occurrenceId="occurrence-april" />);
  await waitFor(() => {
    expect(screen.getByText("3 av 20 platser tagna.")).toBeTruthy();
  });
}

describe("who is on the list", () => {
  it("names a resident", async () => {
    await open();

    expect(screen.getByText("Elin Hammar")).toBeTruthy();
  });

  it("carries no name at all for protected personal data", async () => {
    await open();

    // The board's own address book prints it because a statutory register has
    // to. A list read in a stairwell doorway has no such reason, and the server
    // does not send the name either - so what is asserted here is that the place
    // is still counted and the row says only that.
    const row = screen
      .getByText("Skyddade personuppgifter: se registret.")
      .closest("li");
    expect(row?.textContent).toBe(
      "Skyddade personuppgifter: se registret.Avanmäl",
    );
    expect(screen.getByText("3 av 20 platser tagna.")).toBeTruthy();
  });

  it("says a person the register no longer holds is a place", async () => {
    await open();

    expect(screen.getByText("Finns inte längre i registret.")).toBeTruthy();
  });

  it("keeps somebody who stood down, with nothing left to withdraw", async () => {
    fetchRollCall.mockResolvedValue({
      ok: true,
      value: {
        ...BASE,
        placesTaken: 2,
        entries: [
          {
            signupId: "signup-elin",
            attendee: {
              kind: "resident",
              personId: "person-elin",
              name: "Elin Hammar",
            },
            signedUpAt: "2026-04-02T09:00:00.000Z",
            withdrawnAt: "2026-04-05T09:00:00.000Z",
          },
        ],
      },
    });

    render(<EventRollCall occurrenceId="occurrence-april" />);

    await waitFor(() => {
      expect(screen.getByText("Avanmäld")).toBeTruthy();
    });
    // Who was expected and who changed their mind are two answers rather than
    // one absence, which is why the row stays instead of going.
    expect(screen.getByText("Elin Hammar")).toBeTruthy();
    expect(
      screen.queryByRole("button", {
        name: "Avanmäl deltagaren från den lördag 18 april 2026",
      }),
    ).toBeNull();
  });

  it("tells the rows apart for a reader who cannot see which one is which", async () => {
    await open();

    // One roll-call is one date, so the accessible name is the same on every
    // row: it says which date and not which person, and the act is against one
    // named person's record. The description is the row's own text, so it says
    // who without this component holding a name it may not have - the protected
    // row describes itself as protected and never as somebody.
    const buttons = screen.getAllByRole("button", {
      name: "Avanmäl deltagaren från den lördag 18 april 2026",
    });
    const described = buttons.map((button) => {
      const id = button.getAttribute("aria-describedby");
      return id === null
        ? null
        : (document.getElementById(id)?.textContent ?? null);
    });

    expect(described).toStrictEqual([
      "Elin Hammar",
      "Skyddade personuppgifter: se registret.",
      "Finns inte längre i registret.",
    ]);
  });
});

describe("standing somebody down on their behalf", () => {
  it("sends the sign-up and reads the list again", async () => {
    fetchRollCall
      .mockResolvedValueOnce({ ok: true, value: BASE })
      .mockResolvedValue({ ok: true, value: { ...BASE, placesTaken: 2 } });

    await open();
    const user = userEvent.setup();

    const [first] = screen.getAllByRole("button", {
      name: "Avanmäl deltagaren från den lördag 18 april 2026",
    });
    if (first === undefined) {
      throw new Error("No withdrawal control is on screen.");
    }
    await user.click(first);

    await waitFor(() => {
      expect(screen.getByText("2 av 20 platser tagna.")).toBeTruthy();
    });
    // Keyed on the sign-up, which is what the list gives: the board stands one
    // named person down rather than clearing a date.
    expect(withdrawSignupForBoard).toHaveBeenCalledWith("signup-elin");
    expect(fetchRollCall).toHaveBeenCalledTimes(2);
  });

  it("reads the list again after a refusal too", async () => {
    // A withdrawal refused because somebody had already stood down leaves a list
    // saying otherwise, and the board's next act depends on which of them is
    // true.
    withdrawSignupForBoard.mockResolvedValue({
      ok: false,
      failure: { status: 409, reason: "already-withdrawn" },
    });

    await open();
    const user = userEvent.setup();

    const [first] = screen.getAllByRole("button", {
      name: "Avanmäl deltagaren från den lördag 18 april 2026",
    });
    if (first === undefined) {
      throw new Error("No withdrawal control is on screen.");
    }
    await user.click(first);

    await waitFor(() => {
      expect(
        screen.getByText(
          "Anmälan är redan avanmäld, så det finns inget att avanmäla.",
        ),
      ).toBeTruthy();
    });
    expect(fetchRollCall).toHaveBeenCalledTimes(2);
  });
});

describe("nothing to show", () => {
  it("says nobody has signed up", async () => {
    fetchRollCall.mockResolvedValue({
      ok: true,
      value: { ...BASE, placesTaken: 0, entries: [] },
    });

    render(<EventRollCall occurrenceId="occurrence-april" />);

    await waitFor(() => {
      expect(screen.getByText("Ingen har anmält sig.")).toBeTruthy();
    });
  });

  it("says the list could not be read", async () => {
    fetchRollCall.mockResolvedValue({
      ok: false,
      failure: { status: 500, reason: "unexpected" },
    });

    render(<EventRollCall occurrenceId="occurrence-april" />);

    await waitFor(() => {
      expect(
        screen.getByText("Deltagarlistan kunde inte läsas just nu."),
      ).toBeTruthy();
    });
  });
});

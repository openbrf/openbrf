import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import "../i18n";
import { ApartmentParticularsPanel } from "./ApartmentParticularsPanel";
import type { ApartmentRegisterRow } from "./registers-api";

/**
 * The rooms, other spaces, living area and economic plan panel.
 *
 * What these tests defend is that the whole register is submitted in one act,
 * that each field reaches the API in the form it reads, and that a mistyped
 * room count or an unreadable date stops the save rather than clearing the
 * value already recorded - which is what each would do if sent on, the count
 * as NaN, which JSON writes as null, and the date as the empty value the
 * browser gives it.
 */

const recordApartmentParticulars = vi.fn();

vi.mock("./registers-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./registers-api")>()),
  recordApartmentParticulars: (input: unknown) =>
    recordApartmentParticulars(input),
}));

function row(
  overrides: Partial<ApartmentRegisterRow> = {},
): ApartmentRegisterRow {
  return {
    apartmentId: "apartment-1",
    designation: "Storgatan 12 1001",
    number: "1001",
    addressLabel: "Storgatan 12",
    roomCount: null,
    otherSpaces: null,
    livingArea: null,
    economicPlanRegisteredOn: null,
    initialShareCapital: null,
    participationShare: null,
    holders: [],
    liens: [],
    transfers: [],
    transferReversals: [],
    terminations: [],
    ...overrides,
  };
}

const ROWS = [
  row(),
  row({
    apartmentId: "apartment-2",
    designation: "Storgatan 12 1002",
    number: "1002",
    roomCount: 2,
    otherSpaces: "Kök, förråd nr 4",
    livingArea: "58.0",
    economicPlanRegisteredOn: "1998-03-12",
  }),
];

const OPEN = "Registrera rum, övriga utrymmen, boarea och ekonomisk plan";
const SAVE = "Spara uppgifterna";

beforeEach(() => {
  vi.resetAllMocks();
  recordApartmentParticulars.mockResolvedValue({
    ok: true,
    value: { recorded: 1 },
  });
});

describe("ApartmentParticularsPanel", () => {
  it("is a button until it is opened", () => {
    render(<ApartmentParticularsPanel rows={ROWS} onSaved={vi.fn()} />);

    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("names the paragraph it records for", () => {
    render(<ApartmentParticularsPanel rows={ROWS} onSaved={vi.fn()} />);

    expect(screen.getByText(/BRL 9 kap\. 10 §/u)).toBeTruthy();
  });

  it("submits every apartment in one act, each field as the API reads it", async () => {
    const user = userEvent.setup();
    const onSaved = vi.fn();
    render(<ApartmentParticularsPanel rows={ROWS} onSaved={onSaved} />);

    await user.click(screen.getByRole("button", { name: OPEN }));
    await user.type(
      screen.getByRole("textbox", { name: "Antal rum för Storgatan 12 1001" }),
      "3",
    );
    // A Swedish keyboard's decimal comma, which the API does not read.
    await user.type(
      screen.getByRole("textbox", {
        name: "Boarea i kvadratmeter för Storgatan 12 1001",
      }),
      "74,5",
    );
    await user.type(
      screen.getByRole("textbox", {
        name: "Övriga utrymmen för Storgatan 12 1001",
      }),
      "  Kök, förråd nr 12, uteplats ",
    );
    fireEvent.change(
      screen.getByLabelText(
        "Dag då den ekonomiska planen för Storgatan 12 1001 registrerades",
      ),
      { target: { value: "2004-11-02" } },
    );
    await user.click(screen.getByRole("button", { name: SAVE }));

    await waitFor(() => {
      expect(recordApartmentParticulars).toHaveBeenCalledWith({
        apartments: [
          {
            apartmentId: "apartment-1",
            roomCount: 3,
            otherSpaces: "Kök, förråd nr 12, uteplats",
            livingArea: "74.5",
            economicPlanRegisteredOn: "2004-11-02",
          },
          {
            apartmentId: "apartment-2",
            roomCount: 2,
            otherSpaces: "Kök, förråd nr 4",
            livingArea: "58.0",
            economicPlanRegisteredOn: "1998-03-12",
          },
        ],
      });
    });
    expect(onSaved).toHaveBeenCalled();
  });

  it("sends a cleared field as null rather than as an empty string", async () => {
    const user = userEvent.setup();
    render(
      <ApartmentParticularsPanel rows={[ROWS[1] ?? row()]} onSaved={vi.fn()} />,
    );

    await user.click(screen.getByRole("button", { name: OPEN }));
    await user.clear(
      screen.getByRole("textbox", {
        name: "Övriga utrymmen för Storgatan 12 1002",
      }),
    );
    await user.click(screen.getByRole("button", { name: SAVE }));

    await waitFor(() => {
      expect(recordApartmentParticulars).toHaveBeenCalledWith({
        apartments: [
          expect.objectContaining({
            apartmentId: "apartment-2",
            otherSpaces: null,
          }),
        ],
      });
    });
  });

  it("stops on a room count that is not a whole number, and sends nothing", async () => {
    /*
     * Sent as typed, "2,5" would become NaN and travel as null, and null is
     * how a board clears a count: the apartment's recorded two rooms would be
     * erased by a typo.
     */
    const user = userEvent.setup();
    const onSaved = vi.fn();
    render(
      <ApartmentParticularsPanel rows={[ROWS[1] ?? row()]} onSaved={onSaved} />,
    );

    await user.click(screen.getByRole("button", { name: OPEN }));
    const rooms = screen.getByRole("textbox", {
      name: "Antal rum för Storgatan 12 1002",
    });
    await user.clear(rooms);
    await user.type(rooms, "2,");
    await user.click(screen.getByRole("button", { name: SAVE }));

    expect(await screen.findByText(/kunde inte sparas/u)).toBeTruthy();
    expect(recordApartmentParticulars).not.toHaveBeenCalled();
    expect(onSaved).not.toHaveBeenCalled();
  });

  it("stops on a date the browser cannot read, and sends nothing", async () => {
    /*
     * A half-typed date reads as an empty value, and empty is how a board
     * clears the recorded date: where the browser lets the form submit, the
     * apartment's registered plan date would be erased. jsdom has no partial
     * date entry, so the field reports the bad input the browser would.
     */
    const user = userEvent.setup();
    const onSaved = vi.fn();
    render(
      <ApartmentParticularsPanel rows={[ROWS[1] ?? row()]} onSaved={onSaved} />,
    );

    await user.click(screen.getByRole("button", { name: OPEN }));
    const date = screen.getByLabelText(
      "Dag då den ekonomiska planen för Storgatan 12 1002 registrerades",
    );
    fireEvent.change(date, { target: { value: "" } });
    Object.defineProperty(date, "validity", {
      value: { badInput: true },
    });
    await user.click(screen.getByRole("button", { name: SAVE }));

    expect(await screen.findByText(/kunde inte sparas/u)).toBeTruthy();
    expect(recordApartmentParticulars).not.toHaveBeenCalled();
    expect(onSaved).not.toHaveBeenCalled();
  });

  it("puts a refusal on the panel rather than swallowing it", async () => {
    const user = userEvent.setup();
    recordApartmentParticulars.mockResolvedValue({
      ok: false,
      failure: { status: 400, reason: "date-in-the-future" },
    });
    const onSaved = vi.fn();
    render(<ApartmentParticularsPanel rows={ROWS} onSaved={onSaved} />);

    await user.click(screen.getByRole("button", { name: OPEN }));
    await user.click(screen.getByRole("button", { name: SAVE }));

    expect(await screen.findByText(/kunde inte sparas/u)).toBeTruthy();
    expect(onSaved).not.toHaveBeenCalled();
  });
});

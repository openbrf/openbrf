import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import "../i18n";
import { ApartmentSharesPanel } from "./ApartmentSharesPanel";
import type { ApartmentRegisterRow } from "./registers-api";

/**
 * The participation share and initial share capital panel.
 *
 * Two properties are what these tests defend. The panel says in words that
 * nothing in the platform works a fee out from these figures, because the risk
 * this panel carries is a board coming to believe the platform is maintaining an
 * apportionment it is not. And the whole register is submitted in one act, which
 * is what the panel exists for: a board types eighty figures in one sitting.
 */

const recordApartmentShares = vi.fn();

vi.mock("./registers-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./registers-api")>()),
  recordApartmentShares: (input: unknown) => recordApartmentShares(input),
}));

function row(
  overrides: Partial<ApartmentRegisterRow> = {},
): ApartmentRegisterRow {
  return {
    apartmentId: "apartment-1",
    designation: "Storgatan 12 1001",
    number: "1001",
    addressLabel: "Storgatan 12",
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
    participationShare: "0.02500000",
    initialShareCapital: "125000.00",
  }),
];

beforeEach(() => {
  vi.resetAllMocks();
  recordApartmentShares.mockResolvedValue({ ok: true, value: { recorded: 2 } });
});

describe("ApartmentSharesPanel", () => {
  it("says nothing works a fee out from these figures", () => {
    render(<ApartmentSharesPanel rows={ROWS} onSaved={vi.fn()} />);

    const notice = screen.getByText(/Registret håller siffrorna/u);
    expect(notice.textContent).toContain("9 kap. 5 §");
    expect(notice.textContent).toContain("9 kap. 13 §");
  });

  it("is a button until it is opened", () => {
    // A form of eighty pairs of fields standing open would be the first thing a
    // board member met on a document screen.
    render(<ApartmentSharesPanel rows={ROWS} onSaved={vi.fn()} />);

    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("submits every apartment in one act", async () => {
    const user = userEvent.setup();
    const onSaved = vi.fn();
    render(<ApartmentSharesPanel rows={ROWS} onSaved={onSaved} />);

    await user.click(
      screen.getByRole("button", {
        name: "Registrera andelstal och insatser",
      }),
    );
    await user.type(
      screen.getByRole("textbox", {
        name: "Andelstal för Storgatan 12 1001",
      }),
      "0.03",
    );
    await user.click(screen.getByRole("button", { name: "Spara siffrorna" }));

    await waitFor(() => {
      expect(recordApartmentShares).toHaveBeenCalledWith({
        apartments: [
          {
            apartmentId: "apartment-1",
            participationShare: "0.03",
            // Cleared rather than stored empty: the register states a figure or
            // says none is recorded.
            initialShareCapital: null,
          },
          {
            apartmentId: "apartment-2",
            participationShare: "0.02500000",
            initialShareCapital: "125000.00",
          },
        ],
      });
    });
    expect(onSaved).toHaveBeenCalled();
  });

  it("never sends an apartment the open form had no field for", async () => {
    /*
     * The register is read again while the form stands open - another write on
     * the screen reloads it - and the reload brings an apartment with figures
     * already recorded. The board never saw a field for it, so it must not be
     * in the save at all: sent, it would carry two empty fields, which the
     * server reads as "clear", and its recorded share and insats would be
     * erased from the register by a save nobody aimed at it.
     */
    const user = userEvent.setup();
    const { rerender } = render(
      <ApartmentSharesPanel rows={ROWS} onSaved={vi.fn()} />,
    );

    await user.click(
      screen.getByRole("button", {
        name: "Registrera andelstal och insatser",
      }),
    );

    rerender(
      <ApartmentSharesPanel
        rows={[
          ...ROWS,
          row({
            apartmentId: "apartment-3",
            designation: "Storgatan 12 1003",
            number: "1003",
            participationShare: "0.03000000",
            initialShareCapital: "160000.00",
          }),
        ]}
        onSaved={vi.fn()}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Spara siffrorna" }));

    await waitFor(() => {
      expect(recordApartmentShares).toHaveBeenCalledTimes(1);
    });
    const sent = recordApartmentShares.mock.calls[0]?.[0] as {
      apartments: { apartmentId: string }[];
    };
    expect(sent.apartments.map((apartment) => apartment.apartmentId)).toEqual([
      "apartment-1",
      "apartment-2",
    ]);
  });

  it("puts a refusal on the panel rather than swallowing it", async () => {
    const user = userEvent.setup();
    recordApartmentShares.mockResolvedValue({
      ok: false,
      failure: { status: 400, reason: "participation-share-not-a-number" },
    });
    render(<ApartmentSharesPanel rows={ROWS} onSaved={vi.fn()} />);

    await user.click(
      screen.getByRole("button", {
        name: "Registrera andelstal och insatser",
      }),
    );
    await user.click(screen.getByRole("button", { name: "Spara siffrorna" }));

    expect(await screen.findByText(/kunde inte sparas/u)).toBeTruthy();
  });
});

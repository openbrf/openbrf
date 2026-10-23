import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

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
 * is what the panel exists for: a board types eighty figures in one sitting -
 * each apartment the board member changed, with what it read when the form
 * opened, so a save cannot put back a figure a colleague has since corrected.
 */

const recordApartmentShares = vi.fn();
const onRefresh = vi.fn();

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

const OPEN = "Registrera andelstal och insatser";
const SAVE = "Spara siffrorna";

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
  onRefresh.mockResolvedValue(true);
});

describe("ApartmentSharesPanel", () => {
  it("says nothing works a fee out from these figures", () => {
    render(
      <ApartmentSharesPanel
        rows={ROWS}
        onSaved={vi.fn()}
        onRefresh={onRefresh}
      />,
    );

    const notice = screen.getByText(/Registret håller siffrorna/u);
    expect(notice.textContent).toContain("9 kap. 5 §");
    expect(notice.textContent).toContain("9 kap. 13 §");
  });

  it("is a button until it is opened", () => {
    // A form of eighty pairs of fields standing open would be the first thing a
    // board member met on a document screen.
    render(
      <ApartmentSharesPanel
        rows={ROWS}
        onSaved={vi.fn()}
        onRefresh={onRefresh}
      />,
    );

    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("submits the apartments changed in one act, each with what it read", async () => {
    const user = userEvent.setup();
    const onSaved = vi.fn();
    render(
      <ApartmentSharesPanel
        rows={ROWS}
        onSaved={onSaved}
        onRefresh={onRefresh}
      />,
    );

    await user.click(screen.getByRole("button", { name: OPEN }));
    await user.type(
      screen.getByRole("textbox", {
        name: "Andelstal för Storgatan 12 1001",
      }),
      "0.03",
    );
    const capital = screen.getByRole("textbox", {
      name: "Insats för Storgatan 12 1002",
    });
    await user.clear(capital);
    await user.type(capital, "130000");
    await user.click(screen.getByRole("button", { name: SAVE }));

    await waitFor(() => {
      expect(recordApartmentShares).toHaveBeenCalledWith({
        apartments: [
          {
            apartmentId: "apartment-1",
            participationShare: "0.03",
            // Cleared rather than stored empty: the register states a figure or
            // says none is recorded.
            initialShareCapital: null,
            expected: { participationShare: null, initialShareCapital: null },
          },
          {
            apartmentId: "apartment-2",
            participationShare: "0.02500000",
            initialShareCapital: "130000",
            expected: {
              participationShare: "0.02500000",
              initialShareCapital: "125000.00",
            },
          },
        ],
      });
    });
    expect(onSaved).toHaveBeenCalled();
  });

  it("leaves out an apartment nobody changed", async () => {
    /*
     * Sent, its unchanged figures would be compared against what it read when
     * the form opened, and a colleague's correction since would fail a save
     * that never meant to touch it.
     */
    const user = userEvent.setup();
    render(
      <ApartmentSharesPanel
        rows={ROWS}
        onSaved={vi.fn()}
        onRefresh={onRefresh}
      />,
    );

    await user.click(screen.getByRole("button", { name: OPEN }));
    await user.type(
      screen.getByRole("textbox", { name: "Andelstal för Storgatan 12 1001" }),
      "0.03",
    );
    await user.click(screen.getByRole("button", { name: SAVE }));

    await waitFor(() => {
      expect(recordApartmentShares).toHaveBeenCalledWith({
        apartments: [
          expect.objectContaining({
            apartmentId: "apartment-1",
            participationShare: "0.03",
          }),
        ],
      });
    });
  });

  it("closes without a request when nothing was changed", async () => {
    const user = userEvent.setup();
    const onSaved = vi.fn();
    render(
      <ApartmentSharesPanel
        rows={ROWS}
        onSaved={onSaved}
        onRefresh={onRefresh}
      />,
    );

    await user.click(screen.getByRole("button", { name: OPEN }));
    await user.click(screen.getByRole("button", { name: SAVE }));

    await waitFor(() => {
      expect(onSaved).toHaveBeenCalled();
    });
    expect(recordApartmentShares).not.toHaveBeenCalled();
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("reads a figure typed with a decimal comma and grouped with spaces", async () => {
    // The field offers a Swedish keyboard its comma key, and the API reads only
    // a point.
    const user = userEvent.setup();
    render(
      <ApartmentSharesPanel
        rows={[row()]}
        onSaved={vi.fn()}
        onRefresh={onRefresh}
      />,
    );

    await user.click(screen.getByRole("button", { name: OPEN }));
    await user.type(
      screen.getByRole("textbox", { name: "Andelstal för Storgatan 12 1001" }),
      "0,0125",
    );
    await user.type(
      screen.getByRole("textbox", { name: "Insats för Storgatan 12 1001" }),
      "150 000,50",
    );
    await user.click(screen.getByRole("button", { name: SAVE }));

    await waitFor(() => {
      expect(recordApartmentShares).toHaveBeenCalledWith({
        apartments: [
          {
            apartmentId: "apartment-1",
            participationShare: "0.0125",
            initialShareCapital: "150000.50",
            expected: { participationShare: null, initialShareCapital: null },
          },
        ],
      });
    });
  });

  it("neither shows nor sends an apartment the form did not open with", async () => {
    /*
     * The register is read again while the form stands open - a refused save
     * or another write on the screen reloads it - and the reload brings an
     * apartment with figures already recorded. The form has no draft for it,
     * so a field for it would ignore every keystroke, and it must not be in the
     * save at all: sent, it would carry two empty fields, which the server
     * reads as "clear", and its recorded share and insats would be erased from
     * the register by a save nobody aimed at it.
     */
    const user = userEvent.setup();
    const { rerender } = render(
      <ApartmentSharesPanel
        rows={ROWS}
        onSaved={vi.fn()}
        onRefresh={onRefresh}
      />,
    );

    await user.click(screen.getByRole("button", { name: OPEN }));
    await user.type(
      screen.getByRole("textbox", { name: "Andelstal för Storgatan 12 1001" }),
      "0.03",
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
        onRefresh={onRefresh}
      />,
    );
    expect(screen.queryByText("Storgatan 12 1003")).toBeNull();
    expect(
      screen.queryByRole("textbox", {
        name: "Andelstal för Storgatan 12 1003",
      }),
    ).toBeNull();
    await user.click(screen.getByRole("button", { name: SAVE }));

    await waitFor(() => {
      expect(recordApartmentShares).toHaveBeenCalledTimes(1);
    });
    const sent = recordApartmentShares.mock.calls[0]?.[0] as {
      apartments: { apartmentId: string }[];
    };
    expect(sent.apartments.map((apartment) => apartment.apartmentId)).toEqual([
      "apartment-1",
    ]);
  });

  it("puts a refusal on the panel rather than swallowing it", async () => {
    const user = userEvent.setup();
    recordApartmentShares.mockResolvedValue({
      ok: false,
      failure: { status: 400, reason: "participation-share-not-a-number" },
    });
    const onSaved = vi.fn();
    render(
      <ApartmentSharesPanel
        rows={ROWS}
        onSaved={onSaved}
        onRefresh={onRefresh}
      />,
    );

    await user.click(screen.getByRole("button", { name: OPEN }));
    await user.type(
      screen.getByRole("textbox", { name: "Andelstal för Storgatan 12 1001" }),
      "0.03.1",
    );
    await user.click(screen.getByRole("button", { name: SAVE }));

    expect(await screen.findByText(/kunde inte sparas/u)).toBeTruthy();
    expect(onSaved).not.toHaveBeenCalled();
  });

  it("says when someone else saved first, and keeps what was typed", async () => {
    const user = userEvent.setup();
    recordApartmentShares.mockResolvedValue({
      ok: false,
      failure: { status: 409, reason: "apartment-shares-changed" },
    });
    const onSaved = vi.fn();
    render(
      <ApartmentSharesPanel
        rows={ROWS}
        onSaved={onSaved}
        onRefresh={onRefresh}
      />,
    );

    await user.click(screen.getByRole("button", { name: OPEN }));
    const share = screen.getByRole("textbox", {
      name: "Andelstal för Storgatan 12 1001",
    });
    await user.type(share, "0.03");
    await user.click(screen.getByRole("button", { name: SAVE }));

    expect(await screen.findByText(/Någon annan har sparat/u)).toBeTruthy();
    expect(screen.queryByText(/kunde inte sparas/u)).toBeNull();
    expect((share as HTMLInputElement).value).toBe("0.03");
    expect(onSaved).not.toHaveBeenCalled();
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it("sends the refreshed figures when the form is reopened after a refusal", async () => {
    /*
     * The notice says to cancel and open the form again. The form snapshots
     * the rows when it opens, so that only reaches current figures if the
     * register was read again in between - otherwise the second save carries
     * the same stale expected pair and is refused a second time.
     */
    const user = userEvent.setup();
    recordApartmentShares.mockResolvedValueOnce({
      ok: false,
      failure: { status: 409, reason: "apartment-shares-changed" },
    });
    const refreshed = [
      row({
        participationShare: "0.04000000",
        initialShareCapital: "90000.00",
      }),
      ROWS[1] as ApartmentRegisterRow,
    ];
    const { rerender } = render(
      <ApartmentSharesPanel
        rows={ROWS}
        onSaved={vi.fn()}
        onRefresh={onRefresh}
      />,
    );
    onRefresh.mockImplementation(() => {
      rerender(
        <ApartmentSharesPanel
          rows={refreshed}
          onSaved={vi.fn()}
          onRefresh={onRefresh}
        />,
      );
      return Promise.resolve(true);
    });

    await user.click(screen.getByRole("button", { name: OPEN }));
    await user.type(
      screen.getByRole("textbox", { name: "Andelstal för Storgatan 12 1001" }),
      "0.03",
    );
    await user.click(screen.getByRole("button", { name: SAVE }));
    expect(await screen.findByText(/Någon annan har sparat/u)).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Avbryt" }));
    await user.click(screen.getByRole("button", { name: OPEN }));
    const share = screen.getByRole("textbox", {
      name: "Andelstal för Storgatan 12 1001",
    });
    expect((share as HTMLInputElement).value).toBe("0.04000000");
    await user.clear(share);
    await user.type(share, "0.05");
    await user.click(screen.getByRole("button", { name: SAVE }));

    await waitFor(() => {
      expect(recordApartmentShares).toHaveBeenCalledTimes(2);
    });
    expect(recordApartmentShares).toHaveBeenLastCalledWith({
      apartments: [
        {
          apartmentId: "apartment-1",
          participationShare: "0.05",
          initialShareCapital: "90000.00",
          expected: {
            participationShare: "0.04000000",
            initialShareCapital: "90000.00",
          },
        },
      ],
    });
  });

  it("tells the reader to reload when the register could not be read again", async () => {
    // Reopening would only snapshot the figures the panel already holds.
    const user = userEvent.setup();
    recordApartmentShares.mockResolvedValue({
      ok: false,
      failure: { status: 409, reason: "apartment-shares-changed" },
    });
    onRefresh.mockResolvedValue(false);
    render(
      <ApartmentSharesPanel
        rows={ROWS}
        onSaved={vi.fn()}
        onRefresh={onRefresh}
      />,
    );

    await user.click(screen.getByRole("button", { name: OPEN }));
    const share = screen.getByRole("textbox", {
      name: "Andelstal för Storgatan 12 1001",
    });
    await user.type(share, "0.03");
    await user.click(screen.getByRole("button", { name: SAVE }));

    expect(await screen.findByText(/ladda om sidan/u)).toBeTruthy();
    expect((share as HTMLInputElement).value).toBe("0.03");
  });

  it("clears the notice when the form is cancelled", async () => {
    const user = userEvent.setup();
    recordApartmentShares.mockResolvedValue({
      ok: false,
      failure: { status: 409, reason: "apartment-shares-changed" },
    });
    render(
      <ApartmentSharesPanel
        rows={ROWS}
        onSaved={vi.fn()}
        onRefresh={onRefresh}
      />,
    );

    await user.click(screen.getByRole("button", { name: OPEN }));
    await user.type(
      screen.getByRole("textbox", { name: "Andelstal för Storgatan 12 1001" }),
      "0.03",
    );
    await user.click(screen.getByRole("button", { name: SAVE }));
    expect(await screen.findByText(/Någon annan har sparat/u)).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Avbryt" }));

    expect(screen.queryByText(/Någon annan har sparat/u)).toBeNull();
  });

  it("cannot be cancelled while a save is in flight", async () => {
    // As the particulars panel: a refusal arriving after Cancel would put a
    // notice about a form that is no longer there.
    const user = userEvent.setup();
    let refuse: (value: unknown) => void = () => undefined;
    recordApartmentShares.mockReturnValue(
      new Promise((resolve) => {
        refuse = resolve;
      }),
    );
    render(
      <ApartmentSharesPanel
        rows={ROWS}
        onSaved={vi.fn()}
        onRefresh={onRefresh}
      />,
    );

    await user.click(screen.getByRole("button", { name: OPEN }));
    await user.type(
      screen.getByRole("textbox", { name: "Andelstal för Storgatan 12 1001" }),
      "0.03",
    );
    await user.click(screen.getByRole("button", { name: SAVE }));

    const cancel = screen.getByRole("button", { name: "Avbryt" });
    expect((cancel as HTMLButtonElement).disabled).toBe(true);
    await user.click(cancel);
    expect(screen.getByRole("button", { name: SAVE })).toBeTruthy();

    refuse({
      ok: false,
      failure: { status: 409, reason: "apartment-shares-changed" },
    });
    expect(await screen.findByText(/Någon annan har sparat/u)).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "Avbryt" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
  });
});

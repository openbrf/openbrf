import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import "../i18n";
import { ChargesScreen } from "./ChargesScreen";
import type { ChargeParties } from "./charge-parties";
import type { DebitingList } from "./charges-api";

/**
 * The board's charges screen.
 *
 * Three properties are what these tests defend, and they are the three a
 * reviewer of this module would look for.
 *
 * A protected person's apartment is not printed. The list is a document handed
 * to a bookkeeper outside the association, the server masks the cell, and the
 * screen has to render that as a statement rather than as a blank one - a gap
 * reads as a register that lost the address.
 *
 * The file is produced on an act and not on a read. Producing it writes the
 * audit entry that records the disclosure, so opening the screen must not
 * produce one, and the download only appears once a board member has asked.
 *
 * The screen says what the list is not. A reader who took a debiting list for a
 * statement of what is owed would be reading it as the one thing this module
 * refuses to hold, so the sentence saying so is on the document itself and is
 * asserted here.
 */

const fetchDebitingList = vi.fn();
const exportDebitingList = vi.fn();
const removeCharge = vi.fn();
const recordCharge = vi.fn();
const loadChargeParties = vi.fn();

vi.mock("./charges-api", () => ({
  VAT_TREATMENTS: ["EXEMPT", "RATE"],
  fetchDebitingList: (from: string, to: string) => fetchDebitingList(from, to),
  exportDebitingList: (from: string, to: string) =>
    exportDebitingList(from, to),
  removeCharge: (chargeId: string) => removeCharge(chargeId),
  recordCharge: (input: unknown) => recordCharge(input),
}));

vi.mock("./charge-parties", () => ({
  loadChargeParties: () => loadChargeParties(),
}));

const PARTIES: ChargeParties = {
  persons: [
    {
      personId: "person-1",
      name: "Astrid Vallin",
      apartment: "Storgatan 12 1001",
      movedInOn: "2026-01-15",
      ambiguous: false,
    },
    {
      personId: "person-2",
      name: "Signe Skyddad",
      apartment: null,
      movedInOn: null,
      ambiguous: false,
    },
  ],
  apartments: [{ apartmentId: "apartment-1", label: "Storgatan 12 1002" }],
};

const LIST: DebitingList = {
  housingCooperative: {
    name: "Brf Eksemplet",
    organizationNumber: "769600-0001",
  },
  from: "2026-01-01",
  to: "2026-12-31",
  generatedOn: "2027-01-08",
  total: "1250.00",
  rows: [
    {
      chargeId: "charge-1",
      chargedOn: "2026-03-05",
      chargedTo: {
        kind: "person",
        personId: "person-1",
        name: "Astrid Vallin",
        protectedPersonalData: false,
        apartment: { state: "visible", label: "Storgatan 12 1001" },
      },
      amount: "450.00",
      vatTreatment: "EXEMPT",
      vatRatePercent: null,
      reason: "Nyckel till cykelrummet",
      handedToManagerOn: null,
    },
    {
      chargeId: "charge-2",
      chargedOn: "2026-04-01",
      chargedTo: {
        kind: "person",
        personId: "person-2",
        name: "Signe Skyddad",
        protectedPersonalData: true,
        apartment: { state: "masked" },
      },
      amount: "300.00",
      vatTreatment: "RATE",
      vatRatePercent: 25,
      reason: "Andrahandsavgift",
      handedToManagerOn: "2026-04-30",
    },
    {
      chargeId: "charge-3",
      chargedOn: "2026-05-02",
      chargedTo: {
        kind: "apartment",
        apartmentId: "apartment-1",
        apartment: { state: "visible", label: "Storgatan 12 1002" },
      },
      amount: "500.00",
      vatTreatment: "EXEMPT",
      vatRatePercent: null,
      reason: "Vidaredebiterad reparation",
      handedToManagerOn: null,
    },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  fetchDebitingList.mockResolvedValue({ ok: true, value: LIST });
  loadChargeParties.mockResolvedValue(PARTIES);
});

describe("the debiting list", () => {
  it("prints a protected person's name and withholds their apartment", async () => {
    render(<ChargesScreen />);

    /*
     * Scoped to the document. Both people are also options on the form's own
     * select, and what this asserts is what the printed list says about them.
     */
    const document = within(await screen.findByRole("table"));
    const row = document.getByText("Signe Skyddad").closest("tr");
    expect(row).not.toBeNull();
    expect(row?.textContent).toContain("Skyddad, skrivs inte ut");
    expect(row?.textContent).not.toContain("1001");
    expect(row?.textContent).not.toContain("1002");

    // The unprotected row beside it still carries its apartment, so the
    // withholding is the flag rather than the column being empty for everybody.
    const other = document.getByText("Astrid Vallin").closest("tr");
    expect(other?.textContent).toContain("Storgatan 12 1001");
  });

  it("says that the list is a basis and not a statement of what is owed", async () => {
    render(<ChargesScreen />);

    expect(
      await screen.findByText(/S.ger ingenting om vad som har betalats/i),
    ).toBeTruthy();
  });

  it("names the charged party as the apartment where no person is charged", async () => {
    render(<ChargesScreen />);

    const row = (await screen.findByText("Vidaredebiterad reparation")).closest(
      "tr",
    );
    expect(row?.textContent).toContain("genheten");
    expect(row?.textContent).toContain("Storgatan 12 1002");
  });

  it("states the total of what was charged", async () => {
    render(<ChargesScreen />);

    expect(await screen.findByText("Summa 1250.00 kr")).toBeTruthy();
  });

  it("prints the VAT rate as a number rather than as a placeholder", async () => {
    /*
     * The whole rendered value, and the same for the stamp and the total above.
     * An interpolated key whose variable never arrives renders its placeholder
     * verbatim - "{{percent}} %" on a document handed to a bookkeeper - and an
     * assertion on the surrounding words alone would pass straight through that.
     */
    render(<ChargesScreen />);

    const rows = within(await screen.findByRole("table"));
    const row = rows.getByText("Andrahandsavgift").closest("tr");

    expect(row?.textContent).toContain("25 %");
    expect(row?.textContent).not.toContain("{{");
  });

  it("stamps the document with the period and the day it was produced", async () => {
    render(<ChargesScreen />);

    expect(
      await screen.findByText(
        "Debiteringslängd - 2026-01-01 till 2026-12-31 - framställd 2027-01-08",
      ),
    ).toBeTruthy();
  });

  it("renders no interpolation placeholder anywhere on the screen", async () => {
    // The whole screen rather than one string: every key this module added that
    // takes a variable is rendered here, and a placeholder is the same defect
    // wherever it surfaces.
    render(<ChargesScreen />);

    await screen.findByText("Astrid Vallin");
    expect(document.body.textContent).not.toContain("{{");
  });
});

describe("the file", () => {
  it("is not produced by opening the screen", async () => {
    render(<ChargesScreen />);

    await screen.findByText("Astrid Vallin");
    // Producing it writes the audit entry that records the disclosure, so it
    // has to be an act somebody chose to take.
    expect(exportDebitingList).not.toHaveBeenCalled();
  });

  it("is offered for download only once it has been asked for", async () => {
    exportDebitingList.mockResolvedValue({
      ok: true,
      value: {
        list: LIST,
        fileName: "debiteringslangd-2026-01-01-2026-12-31.csv",
        csv: "chargedOn;party\r\n",
      },
    });
    render(<ChargesScreen />);
    await screen.findByText("Astrid Vallin");

    expect(screen.queryByRole("link", { name: "Hämta filen" })).toBeNull();

    await userEvent.click(
      screen.getByRole("button", { name: "Ta fram filen" }),
    );

    const link = await screen.findByRole("link", { name: "Hämta filen" });
    expect(link.getAttribute("download")).toBe(
      "debiteringslangd-2026-01-01-2026-12-31.csv",
    );
  });

  it("drops a file the list moved on from while it was being produced", async () => {
    let answer = (): void => undefined;
    exportDebitingList.mockImplementation(
      () =>
        new Promise((resolve) => {
          answer = (): void => {
            resolve({
              ok: true,
              value: {
                list: LIST,
                fileName: "debiteringslangd-2026-01-01-2026-12-31.csv",
                csv: "chargedOn;party\r\n",
              },
            });
          };
        }),
    );

    render(<ChargesScreen />);
    await screen.findByText("Astrid Vallin");

    await userEvent.click(
      screen.getByRole("button", { name: "Ta fram filen" }),
    );

    // A charge is removed while the file is being produced, which reads the
    // period again. The period is unchanged, so nothing about the dates says
    // the rows moved - but they did, and the file was produced before it.
    removeCharge.mockResolvedValue({ ok: true, value: undefined });
    const row = (await screen.findByText("Nyckel till cykelrummet")).closest(
      "tr",
    );
    await userEvent.click(
      within(row as HTMLElement).getByRole("button", { name: "Ta bort" }),
    );
    await waitFor(() => {
      expect(fetchDebitingList).toHaveBeenCalledTimes(2);
    });

    answer();

    await waitFor(() => {
      expect(exportDebitingList).toHaveBeenCalledTimes(1);
    });
    expect(screen.queryByRole("link", { name: "Hämta filen" })).toBeNull();
  });
});

describe("when the read fails", () => {
  it("offers a retry rather than telling the board to reload the page", async () => {
    fetchDebitingList.mockResolvedValue({
      ok: false,
      failure: { status: 500, reason: "unexpected" },
    });
    render(<ChargesScreen />);

    await screen.findByText(/kunde inte l.sas just nu/i);

    fetchDebitingList.mockResolvedValue({ ok: true, value: LIST });
    await userEvent.click(screen.getByRole("button", { name: "Försök igen" }));

    expect(await screen.findByText("Astrid Vallin")).toBeTruthy();
  });

  it("takes the document away when the read is refused after a permitted one", async () => {
    render(<ChargesScreen />);
    await screen.findByText("Nyckel till cykelrummet");

    // The seat lost the capability between the two reads. What the permitted
    // read put on the screen is other members' charges, so it goes with it.
    fetchDebitingList.mockResolvedValue({
      ok: false,
      failure: { status: 403, reason: "forbidden" },
    });
    fireEvent.change(screen.getByLabelText("Från"), {
      target: { value: "2026-02-01" },
    });

    await waitFor(() => {
      expect(screen.queryByText("Nyckel till cykelrummet")).toBeNull();
    });
    expect(screen.queryByText("Andrahandsavgift")).toBeNull();
  });

  it("takes the previous period away when the next one is refused", async () => {
    render(<ChargesScreen />);
    await screen.findByText("Nyckel till cykelrummet");

    // A refused period is not a permission failure, so the document is not
    // taken away for that reason - but it belongs to the period that was asked
    // for, and the board is now asking for a different one. Leaving it would
    // put a remove button beside a charge from a period the controls no longer
    // name.
    fetchDebitingList.mockResolvedValue({
      ok: false,
      failure: { status: 422, reason: "range-invalid" },
    });
    fireEvent.change(screen.getByLabelText("Från"), {
      target: { value: "2026-04-01" },
    });

    expect(
      await screen.findByText("Perioden kan inte sluta innan den börjar."),
    ).toBeTruthy();
    expect(screen.queryByText("Nyckel till cykelrummet")).toBeNull();
    expect(screen.queryByRole("button", { name: "Ta bort" })).toBeNull();
  });

  it("treats a refused period as something to correct, not as a failed read", async () => {
    // The board stated something it can change on the controls above, so the
    // screen says which and keeps the form rather than offering a retry.
    fetchDebitingList.mockResolvedValue({
      ok: false,
      failure: { status: 422, reason: "range-invalid" },
    });
    render(<ChargesScreen />);

    expect(
      await screen.findByText("Perioden kan inte sluta innan den börjar."),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Försök igen" })).toBeNull();
  });
});

describe("removing a charge", () => {
  it("re-reads the list, so the document matches what is stored", async () => {
    removeCharge.mockResolvedValue({ ok: true, value: undefined });
    render(<ChargesScreen />);
    await screen.findByText("Astrid Vallin");

    const row = screen.getByText("Nyckel till cykelrummet").closest("tr");
    expect(row).not.toBeNull();
    // By its accessible name, which is the contract: the first button in the row
    // would be found even if it had lost the label a screen reader announces.
    await userEvent.click(
      within(row as HTMLElement).getByRole("button", { name: "Ta bort" }),
    );

    expect(removeCharge).toHaveBeenCalledWith("charge-1");
    await waitFor(() => {
      expect(fetchDebitingList.mock.calls.length).toBeGreaterThan(1);
    });
  });
});

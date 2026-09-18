import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import "../i18n";
import { FeesScreen } from "./FeesScreen";
import type { FeeNoticeExport, FeeRegister } from "./fees-api";

/**
 * The board's fee screen.
 *
 * Four properties are what these tests defend, and they are the four a reviewer
 * of this module would look for.
 *
 * The screen says what it is not. There is no paid column and no outstanding
 * figure anywhere on it, and the sentence saying the accounting system settles
 * the debt is on the screen rather than only in a comment - this is exactly
 * where a board expects to see a balance.
 *
 * The andelstal aid suggests and never decides. It is closed until it is asked
 * for, it recomputes on demand, it stores nothing, and the screen states in
 * words that the amount the board records is what applies.
 *
 * The document is produced on an act and not on a read. Producing it writes the
 * audit entry that records the disclosure, so opening the screen must not
 * produce one, and the download only appears once somebody has asked.
 *
 * A protected holder's name is not printed. The notice is keyed on the
 * apartment, which can never be withheld without emptying the row, so the
 * masking falls on the name - and the screen renders that as a statement rather
 * than as a blank cell.
 */

const fetchFeeRegister = vi.fn();
const recordFee = vi.fn();
const removeFee = vi.fn();
const fetchFeeNotifications = vi.fn();
const issueFeeNotification = vi.fn();
const produceFeeNotices = vi.fn();

vi.mock("./fees-api", () => ({
  fetchFeeRegister: (on: string) => fetchFeeRegister(on),
  recordFee: (input: unknown) => recordFee(input),
  removeFee: (feeId: string) => removeFee(feeId),
  fetchFeeNotifications: () => fetchFeeNotifications(),
  issueFeeNotification: (input: unknown) => issueFeeNotification(input),
  produceFeeNotices: (id: string) => produceFeeNotices(id),
}));

const REGISTER: FeeRegister = {
  housingCooperative: {
    name: "Brf Eksemplet",
    organizationNumber: "769600-0000",
    bankgiro: "123-4567",
    plusgiro: null,
  },
  on: "2026-09-18",
  apartments: [
    {
      apartmentId: "apartment-1",
      number: "1001",
      label: "Storgatan 12 1001",
      participationShare: "0.02500000",
      fees: [
        {
          feeId: "fee-1",
          apartmentId: "apartment-1",
          kind: "ANNUAL_FEE",
          appliesFrom: "2026-01-01",
          appliesUntil: null,
          monthlyAmount: "3450.50",
          vatTreatment: "EXEMPT",
          vatRatePercent: null,
        },
      ],
      monthlyAmount: "3450.50",
    },
    {
      apartmentId: "apartment-2",
      number: "1002",
      label: "Storgatan 12 1002",
      participationShare: null,
      fees: [],
      monthlyAmount: "0.00",
    },
  ],
  monthlyTotal: "3450.50",
};

const PRODUCED: FeeNoticeExport = {
  fileName: "avier-2026-01-01-2026-03-31.csv",
  csv: "apartment;amount\r\n",
  document: {
    housingCooperative: REGISTER.housingCooperative,
    notificationId: "run-1",
    from: "2026-01-01",
    to: "2026-03-31",
    dueOn: "2026-01-31",
    issuedOn: "2026-01-02",
    generatedOn: "2026-01-02",
    rows: [
      {
        noticeId: "notice-1",
        apartment: "Storgatan 12 1001",
        apartmentNumber: "1001",
        holders: { state: "visible", names: ["Astrid Vallin"] },
        amount: "10351.50",
        paymentReference: "260100018",
      },
      {
        noticeId: "notice-2",
        apartment: "Storgatan 12 1002",
        apartmentNumber: "1002",
        holders: { state: "withheld" },
        amount: "9000.00",
        paymentReference: "260100026",
      },
    ],
    total: "19351.50",
  },
};

beforeEach(() => {
  vi.resetAllMocks();
  fetchFeeRegister.mockResolvedValue({ ok: true, value: REGISTER });
  fetchFeeNotifications.mockResolvedValue({
    ok: true,
    value: [
      {
        notificationId: "run-1",
        from: "2026-01-01",
        to: "2026-03-31",
        dueOn: "2026-01-31",
        issuedOn: "2026-01-02",
        notices: 2,
        total: "19351.50",
      },
    ],
  });
  produceFeeNotices.mockResolvedValue({ ok: true, value: PRODUCED });
});

describe("the fee register", () => {
  it("states the monthly amount as a figure a member could check", async () => {
    render(<FeesScreen />);

    // Grouped and to the ore, rather than the server's own "3450.50": this is
    // the first screen in the application that formats money at all. Twice,
    // because the row states it and the stamp sums it.
    const shown = await screen.findAllByText(/3\s*450,50 kr/u);
    expect(shown.length).toBeGreaterThan(0);
  });

  it("says the accounting system settles the debt", async () => {
    render(<FeesScreen />);

    expect(await screen.findByText(/bokföringssystemet/u)).toBeTruthy();
  });

  it("carries no paid, outstanding or balance column", async () => {
    render(<FeesScreen />);
    await screen.findByText(/Avgiftsregister - gäller/u);

    const headers = screen
      .getAllByRole("columnheader")
      .map((header) => header.textContent ?? "");
    for (const header of headers) {
      expect(header.toLowerCase()).not.toContain("betal");
      expect(header.toLowerCase()).not.toContain("saldo");
      expect(header.toLowerCase()).not.toContain("skuld");
    }
  });

  it("says plainly which apartments have no fee recorded", async () => {
    // A blank cell reads as a register that lost the figure; the column's own
    // sentence is what says the emptiness is deliberate.
    render(<FeesScreen />);

    expect(await screen.findByText("Ingen avgift registrerad")).toBeTruthy();
  });
});

describe("the andelstal aid", () => {
  it("is closed until it is asked for", async () => {
    render(<FeesScreen />);
    await screen.findByText(/Avgiftsregister - gäller/u);

    expect(screen.queryByLabelText(/Årets summa/u)).toBeNull();
  });

  it("says in words that it decides nothing", async () => {
    render(<FeesScreen />);
    await screen.findByText(/Avgiftsregister - gäller/u);

    // The aid's own notice cites both sections: the basis is a bylaws matter
    // and fixing the amounts is the board's.
    const notice = screen.getByText(/lagras aldrig/u);
    expect(notice.textContent).toContain("9 kap. 5 §");
    expect(notice.textContent).toContain("9 kap. 13 §");
  });

  it("suggests a figure per apartment and stores nothing", async () => {
    const user = userEvent.setup();
    render(<FeesScreen />);
    await screen.findByText(/Avgiftsregister - gäller/u);

    await user.click(screen.getByRole("button", { name: "Visa hjälpen" }));
    await user.type(
      screen.getByRole("textbox", { name: /Årets summa/u }),
      "1200000",
    );

    // Two and a half per cent of 1 200 000 over twelve months is 2 500.
    expect(
      (await screen.findAllByText(/2\s*500,00 kr/u)).length,
    ).toBeGreaterThan(0);
    // Nothing was written: the aid is arithmetic on the screen.
    expect(recordFee).not.toHaveBeenCalled();
  });

  it("offers nothing for an apartment with no participation share", async () => {
    const user = userEvent.setup();
    render(<FeesScreen />);
    await screen.findByText(/Avgiftsregister - gäller/u);

    await user.click(screen.getByRole("button", { name: "Visa hjälpen" }));
    await user.type(
      screen.getByRole("textbox", { name: /Årets summa/u }),
      "1200000",
    );

    expect(await screen.findByText(/Inget förslag/u)).toBeTruthy();
  });
});

describe("the notices", () => {
  it("produces the document on an act and not on a read", async () => {
    const user = userEvent.setup();
    render(<FeesScreen />);
    await screen.findByText(/Avgiftsregister - gäller/u);

    // Opening the screen is not a disclosure, so nothing has been produced.
    expect(produceFeeNotices).not.toHaveBeenCalled();
    expect(screen.queryByRole("link", { name: "Hämta filen" })).toBeNull();

    // Awaited rather than taken from the render: the notification panel makes a
    // read of its own, and the register document above it can arrive first.
    await user.click(
      await screen.findByRole("button", {
        name: "Ta fram dokumentet för 2026-01-01 till 2026-03-31",
      }),
    );

    await waitFor(() => {
      expect(produceFeeNotices).toHaveBeenCalledWith("run-1");
    });
    expect(
      await screen.findByRole("link", { name: "Hämta filen" }),
    ).toBeTruthy();
  });

  it("withholds a protected holder's name and says that it did", async () => {
    const user = userEvent.setup();
    render(<FeesScreen />);
    await screen.findByText(/Avgiftsregister - gäller/u);

    // Awaited rather than taken from the render: the notification panel makes a
    // read of its own, and the register document above it can arrive first.
    await user.click(
      await screen.findByRole("button", {
        name: "Ta fram dokumentet för 2026-01-01 till 2026-03-31",
      }),
    );

    const document = await screen.findByRole("table", { name: "Avier" });
    expect(within(document).getByText("Astrid Vallin")).toBeTruthy();
    // The flat is on the row either way, because withholding it would empty the
    // notice of the thing it is about.
    expect(within(document).getByText("Storgatan 12 1002")).toBeTruthy();
    expect(
      within(document).getByText(
        "Skyddade personuppgifter, namnet skrivs inte ut",
      ),
    ).toBeTruthy();
  });

  it("says the notices are produced rather than sent", async () => {
    render(<FeesScreen />);

    expect(await screen.findByText(/Ingenting skickas härifrån/u)).toBeTruthy();
  });

  it("says the notice is not an invoice once one is produced", async () => {
    const user = userEvent.setup();
    render(<FeesScreen />);
    await screen.findByText(/Avgiftsregister - gäller/u);

    // Awaited rather than taken from the render: the notification panel makes a
    // read of its own, and the register document above it can arrive first.
    await user.click(
      await screen.findByRole("button", {
        name: "Ta fram dokumentet för 2026-01-01 till 2026-03-31",
      }),
    );

    expect(await screen.findByText(/inte en faktura/u)).toBeTruthy();
  });
});

describe("recording a fee", () => {
  it("sends what the board stated and reads the register back", async () => {
    const user = userEvent.setup();
    recordFee.mockResolvedValue({
      ok: true,
      value: REGISTER.apartments[0]?.fees[0],
    });
    render(<FeesScreen />);
    await screen.findByText(/Avgiftsregister - gäller/u);

    await user.selectOptions(
      screen.getByRole("combobox", { name: "Lägenhet" }),
      "apartment-1",
    );
    await user.type(
      screen.getByRole("textbox", { name: "Belopp per månad i kronor" }),
      "3600.00",
    );
    await user.click(
      screen.getByRole("button", { name: "Registrera avgiften" }),
    );

    await waitFor(() => {
      expect(recordFee).toHaveBeenCalledWith(
        expect.objectContaining({
          apartmentId: "apartment-1",
          kind: "ANNUAL_FEE",
          monthlyAmount: "3600.00",
          vatTreatment: "EXEMPT",
          vatRatePercent: null,
        }),
      );
    });
    // Two reads: the first on load, the second once the rate was stored.
    await waitFor(() => {
      expect(fetchFeeRegister).toHaveBeenCalledTimes(2);
    });
  });

  it("puts the refusal on the screen rather than swallowing it", async () => {
    const user = userEvent.setup();
    recordFee.mockResolvedValue({
      ok: false,
      failure: { status: 409, reason: "fee-already-recorded-later" },
    });
    render(<FeesScreen />);
    await screen.findByText(/Avgiftsregister - gäller/u);

    await user.selectOptions(
      screen.getByRole("combobox", { name: "Lägenhet" }),
      "apartment-1",
    );
    await user.type(
      screen.getByRole("textbox", { name: "Belopp per månad i kronor" }),
      "3600.00",
    );
    await user.click(
      screen.getByRole("button", { name: "Registrera avgiften" }),
    );

    expect(
      await screen.findByText(/senare avgift av samma slag/u),
    ).toBeTruthy();
  });

  it("says a fee may be dated forward and a charge may not", async () => {
    render(<FeesScreen />);

    expect(await screen.findByText(/dateras framåt/u)).toBeTruthy();
  });
});

describe("when the viewer holds nothing here", () => {
  it("says who handles fees rather than showing an empty register", async () => {
    fetchFeeRegister.mockResolvedValue({
      ok: false,
      failure: { status: 403, reason: "forbidden" },
    });
    render(<FeesScreen />);

    expect(
      await screen.findByText(/Avgifter hanteras av styrelsen/u),
    ).toBeTruthy();
  });
});

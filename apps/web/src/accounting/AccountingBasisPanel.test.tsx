import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import "../i18n";
import { AccountingBasisPanel } from "./AccountingBasisPanel";
import type {
  AccountingBasisExport,
  AccountingBasisRow,
} from "./accounting-api";

/**
 * The accounting basis panel.
 *
 * Three properties are what these tests defend. The panel says in words that
 * the file is a basis and not a ledger, because the risk it carries is a board
 * coming to believe Open BRF is keeping accounts it is not. Nothing is offered
 * for download until the server has answered, since producing the file is what
 * records the disclosure and a link the browser could follow on its own would
 * be an unaudited one. And the two halves are counted and totalled apart,
 * which is the check a board makes before handing the file on.
 */

const exportAccountingBasis = vi.fn();

vi.mock("./accounting-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./accounting-api")>()),
  exportAccountingBasis: (period: unknown) => exportAccountingBasis(period),
}));

function feeRow(
  overrides: Partial<AccountingBasisRow> = {},
): AccountingBasisRow {
  return {
    kind: "FEE_NOTICE",
    rowId: "notice-1",
    from: "2026-01-01",
    to: "2026-03-31",
    apartment: { state: "visible", label: "Storgatan 12 1001" },
    name: null,
    amount: "10351.50",
    vatTreatment: null,
    vatRatePercent: null,
    reason: null,
    paymentReference: "260100018",
    ...overrides,
  };
}

const TAKEN: AccountingBasisExport = {
  basis: {
    housingCooperative: { name: "Brf Talgoxen", organizationNumber: null },
    from: "2026-01-01",
    to: "2026-12-31",
    generatedOn: "2026-09-18",
    rows: [
      feeRow(),
      feeRow({ rowId: "notice-2", amount: "6000.00" }),
      {
        kind: "MEMBER_CHARGE",
        rowId: "charge-1",
        from: "2026-02-14",
        to: "2026-02-14",
        apartment: { state: "withheld" },
        name: "Astrid Vallin",
        amount: "450.00",
        vatTreatment: "EXEMPT",
        vatRatePercent: null,
        reason: "Nyckel till cykelrummet",
        paymentReference: null,
      },
    ],
    feeTotal: "16351.50",
    chargeTotal: "450.00",
    total: "16801.50",
  },
  fileName: "bokforingsunderlag-2026-01-01-2026-12-31.csv",
  csv: "kind;periodFrom\r\n",
};

beforeEach(() => {
  vi.resetAllMocks();
  exportAccountingBasis.mockResolvedValue({ ok: true, value: TAKEN });
});

describe("AccountingBasisPanel", () => {
  it("says the file is a basis and not a ledger", () => {
    render(<AccountingBasisPanel onRefused={vi.fn()} />);

    const notice = screen.getByText(/inga kontonummer/u);
    expect(notice.textContent).toContain("ingenting om betalning");
  });

  it("offers nothing to download before the server has answered", () => {
    render(<AccountingBasisPanel onRefused={vi.fn()} />);

    expect(screen.queryByRole("link")).toBeNull();
  });

  it("asks for the period the board stated", async () => {
    render(<AccountingBasisPanel onRefused={vi.fn()} />);

    await userEvent.clear(screen.getByLabelText("Från och med"));
    await userEvent.type(screen.getByLabelText("Från och med"), "2025-04-01");
    await userEvent.clear(screen.getByLabelText("Till och med"));
    await userEvent.type(screen.getByLabelText("Till och med"), "2025-06-30");
    await userEvent.click(
      screen.getByRole("button", { name: "Ta fram bokföringsunderlaget" }),
    );

    await waitFor(() => {
      expect(exportAccountingBasis).toHaveBeenCalledWith({
        from: "2025-04-01",
        to: "2025-06-30",
      });
    });
  });

  it("counts and totals the two halves apart", async () => {
    render(<AccountingBasisPanel onRefused={vi.fn()} />);

    await userEvent.click(
      screen.getByRole("button", { name: "Ta fram bokföringsunderlaget" }),
    );

    // A pattern rather than the text: Intl.NumberFormat gives Swedish a
    // no-break space between the groups, and which one it is has moved between
    // ICU versions.
    expect(await screen.findByText(/2 rader, 16\s*351,50 kr/u)).toBeTruthy();
    expect(screen.getByText(/1 rad, 450,00 kr/u)).toBeTruthy();
    expect(screen.getByText(/16\s*801,50 kr/u)).toBeTruthy();
  });

  it("offers the file under the period's own name once it is produced", async () => {
    render(<AccountingBasisPanel onRefused={vi.fn()} />);

    await userEvent.click(
      screen.getByRole("button", { name: "Ta fram bokföringsunderlaget" }),
    );

    const link = await screen.findByRole("link", {
      name: "Hämta bokföringsunderlaget",
    });
    expect(link.getAttribute("download")).toBe(
      "bokforingsunderlag-2026-01-01-2026-12-31.csv",
    );
    expect(link.getAttribute("href")).toContain("data:text/csv");
  });

  it("reports a refusal through the screen and offers no file", async () => {
    const onRefused = vi.fn();
    exportAccountingBasis.mockResolvedValue({
      ok: false,
      failure: { status: 422, reason: "range-invalid" },
    });
    render(<AccountingBasisPanel onRefused={onRefused} />);

    await userEvent.click(
      screen.getByRole("button", { name: "Ta fram bokföringsunderlaget" }),
    );

    await waitFor(() => {
      expect(onRefused).toHaveBeenCalledWith("accounting.errors.rangeInvalid");
    });
    expect(screen.queryByRole("link")).toBeNull();
  });
});

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import "../i18n";
import { FinancesPanel } from "./FinancesPanel";

/**
 * The association's financial year and giro numbers.
 *
 * Two properties are what these tests defend. The panel says what the month
 * reaches - it is stamped on every charge and fee recorded afterwards and decides
 * when each becomes erasable, while rows already recorded keep their own - so a
 * board changing it knows no date already stated to a named person moves. And
 * a giro number is passed through exactly as the board wrote it, because the
 * notice prints it and a helpfully reformatted number is one a member cannot
 * match against their bank statement.
 */

const saveFinances = vi.fn();

vi.mock("../api/instance", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/instance")>()),
  saveFinances: (input: unknown) => saveFinances(input),
}));

beforeEach(() => {
  vi.resetAllMocks();
  saveFinances.mockResolvedValue({
    ok: true,
    value: { financialYearStartMonth: 5, bankgiro: "123-4567", plusgiro: null },
  });
});

describe("FinancesPanel", () => {
  it("says what changing the month moves", () => {
    render(
      <FinancesPanel
        finances={{
          financialYearStartMonth: 1,
          bankgiro: null,
          plusgiro: null,
        }}
      />,
    );

    const notice = screen.getByText(/gallras/u);
    expect(notice.textContent).toContain("7 kap. 2 §");
    // And its reach: only what is recorded afterwards, so no date already given
    // moves - which is what makes the change safe to make at all.
    expect(notice.textContent).toContain("registreras efteråt");
    expect(notice.textContent).toContain("inget gallringsdatum flyttas");
  });

  it("offers the calendar year as the default", () => {
    render(
      <FinancesPanel
        finances={{
          financialYearStartMonth: 1,
          bankgiro: null,
          plusgiro: null,
        }}
      />,
    );

    expect(
      screen.getByRole("combobox", { name: /Räkenskapsåret börjar i/u }),
    ).toHaveProperty("value", "1");
  });

  it("stores a broken financial year and the giro numbers as written", async () => {
    const user = userEvent.setup();
    render(
      <FinancesPanel
        finances={{
          financialYearStartMonth: 1,
          bankgiro: null,
          plusgiro: null,
        }}
      />,
    );

    await user.selectOptions(
      screen.getByRole("combobox", { name: /Räkenskapsåret börjar i/u }),
      "5",
    );
    await user.type(
      screen.getByRole("textbox", { name: "Bankgiro" }),
      "123-4567",
    );
    await user.click(screen.getByRole("button", { name: "Spara" }));

    await waitFor(() => {
      // Never reformatted: a board writes the number the way its own bank
      // prints it.
      expect(saveFinances).toHaveBeenCalledWith({
        financialYearStartMonth: 5,
        bankgiro: "123-4567",
        plusgiro: null,
      });
    });
  });

  it("clears rather than stores an empty giro number", async () => {
    const user = userEvent.setup();
    render(
      <FinancesPanel
        finances={{
          financialYearStartMonth: 1,
          bankgiro: "123-4567",
          plusgiro: null,
        }}
      />,
    );

    await user.clear(screen.getByRole("textbox", { name: "Bankgiro" }));
    await user.click(screen.getByRole("button", { name: "Spara" }));

    await waitFor(() => {
      expect(saveFinances).toHaveBeenCalledWith(
        expect.objectContaining({ bankgiro: null }),
      );
    });
  });

  it("puts the refusal on the panel rather than swallowing it", async () => {
    const user = userEvent.setup();
    saveFinances.mockResolvedValue({
      ok: false,
      failure: { status: 400, reason: "giro-not-a-number" },
    });
    render(
      <FinancesPanel
        finances={{
          financialYearStartMonth: 1,
          bankgiro: null,
          plusgiro: null,
        }}
      />,
    );

    await user.type(screen.getByRole("textbox", { name: "Bankgiro" }), "abc");
    await user.click(screen.getByRole("button", { name: "Spara" }));

    expect(await screen.findByText(/Det är inget gironummer/u)).toBeTruthy();
  });

  it("offers no way to save where the viewer cannot change settings", () => {
    render(
      <FinancesPanel
        finances={{
          financialYearStartMonth: 1,
          bankgiro: null,
          plusgiro: null,
        }}
        editable={false}
      />,
    );

    expect(screen.queryByRole("button", { name: "Spara" })).toBeNull();
  });
});

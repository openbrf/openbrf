import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import "../i18n";
import type { ChargeParties } from "./charge-parties";
import { RecordChargePanel } from "./RecordChargePanel";

/**
 * The form that records one charge.
 *
 * What it defends is that the form cannot ask a board member for something the
 * server will refuse. A charge names a person or an apartment and never both, so
 * only one select is on the page at a time; a rate belongs to the treatment that
 * has one, so the field appears with it and not beside it. Both refusals exist
 * on the server as well - they are the table's own constraints - and a form that
 * invited either would be the platform refusing what it just offered.
 *
 * The third property is the personal identity number. The reason is copied into
 * a file that leaves the association, so a refusal has to say what to do about
 * it rather than reporting that a save failed.
 */

const recordCharge = vi.fn();

vi.mock("./charges-api", () => ({
  VAT_TREATMENTS: ["EXEMPT", "RATE"],
  recordCharge: (input: unknown) => recordCharge(input),
}));

const PARTIES: ChargeParties = {
  persons: [
    {
      personId: "person-1",
      name: "Astrid Vallin",
      apartment: "Storgatan 12 1001",
    },
  ],
  apartments: [{ apartmentId: "apartment-1", label: "Storgatan 12 1002" }],
};

function panel(): void {
  render(
    <RecordChargePanel
      parties={PARTIES}
      today="2026-06-01"
      onRecorded={() => undefined}
    />,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  recordCharge.mockResolvedValue({
    ok: true,
    value: { chargeId: "charge-1" },
  });
});

describe("the charged party", () => {
  it("offers one control at a time, never both", async () => {
    panel();

    expect(screen.getByLabelText("Medlem")).toBeTruthy();
    expect(screen.queryByLabelText("Lägenhet")).toBeNull();

    await userEvent.click(screen.getByRole("radio", { name: "En lägenhet" }));

    expect(screen.getByLabelText("Lägenhet")).toBeTruthy();
    expect(screen.queryByLabelText("Medlem")).toBeNull();
  });

  it("sends the one that was chosen and null for the other", async () => {
    panel();

    await userEvent.selectOptions(screen.getByLabelText("Medlem"), "person-1");
    await userEvent.type(screen.getByLabelText("Belopp i kronor"), "450.00");
    await userEvent.type(
      screen.getByLabelText("Vad debiteringen avser"),
      "Nyckel till cykelrummet",
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Registrera debiteringen" }),
    );

    expect(recordCharge).toHaveBeenCalledWith(
      expect.objectContaining({
        personId: "person-1",
        apartmentId: null,
        chargedOn: "2026-06-01",
        amount: "450.00",
        vatTreatment: "EXEMPT",
        vatRatePercent: null,
        handedToManagerOn: null,
      }),
    );
  });
});

describe("value added tax", () => {
  it("offers the rate only with the treatment that carries one", async () => {
    panel();

    expect(screen.queryByLabelText("Sats i procent")).toBeNull();

    await userEvent.selectOptions(screen.getByLabelText("Moms"), "RATE");

    expect(screen.getByLabelText("Sats i procent")).toBeTruthy();
  });

  it("sends the rate as a whole number", async () => {
    panel();

    await userEvent.selectOptions(screen.getByLabelText("Medlem"), "person-1");
    await userEvent.type(screen.getByLabelText("Belopp i kronor"), "1000.00");
    await userEvent.type(
      screen.getByLabelText("Vad debiteringen avser"),
      "Uthyrd parkeringsplats",
    );
    await userEvent.selectOptions(screen.getByLabelText("Moms"), "RATE");
    await userEvent.type(screen.getByLabelText("Sats i procent"), "25");
    await userEvent.click(
      screen.getByRole("button", { name: "Registrera debiteringen" }),
    );

    expect(recordCharge).toHaveBeenCalledWith(
      expect.objectContaining({ vatTreatment: "RATE", vatRatePercent: 25 }),
    );
  });
});

describe("a refusal", () => {
  it("says what to do about a personal identity number in the reason", async () => {
    recordCharge.mockResolvedValue({
      ok: false,
      failure: {
        status: 422,
        reason: "personal-identity-number",
        detail: [{ field: "reason", offset: 10 }],
      },
    });
    panel();

    await userEvent.selectOptions(screen.getByLabelText("Medlem"), "person-1");
    await userEvent.type(screen.getByLabelText("Belopp i kronor"), "450.00");
    await userEvent.type(
      screen.getByLabelText("Vad debiteringen avser"),
      "Nyckel at 811228-9874",
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Registrera debiteringen" }),
    );

    const notice = await screen.findByText(/personnummer/i);
    expect(notice.textContent).toContain("Ett nummer hittades i texten.");
    expect(notice.textContent).not.toContain("{{");
  });

  it("counts several of them, with the number substituted", async () => {
    /*
     * The plural form, which is the only one of the two that interpolates. A
     * key whose variable never arrives renders "{{count}} nummer hittades i
     * texten." to the board member, and an assertion on the words around it
     * would pass through that.
     */
    recordCharge.mockResolvedValue({
      ok: false,
      failure: {
        status: 422,
        reason: "personal-identity-number",
        detail: [
          { field: "reason", offset: 10 },
          { field: "reason", offset: 30 },
        ],
      },
    });
    panel();

    await userEvent.selectOptions(screen.getByLabelText("Medlem"), "person-1");
    await userEvent.type(screen.getByLabelText("Belopp i kronor"), "450.00");
    await userEvent.type(
      screen.getByLabelText("Vad debiteringen avser"),
      "Nycklar at 811228-9874 och 811228-9874",
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Registrera debiteringen" }),
    );

    const notice = await screen.findByText(/personnummer/i);
    expect(notice.textContent).toContain("2 nummer hittades i texten.");
  });

  it("keeps what was typed, so a refusal is not a re-entry", async () => {
    recordCharge.mockResolvedValue({
      ok: false,
      failure: { status: 422, reason: "amount-not-positive" },
    });
    panel();

    await userEvent.selectOptions(screen.getByLabelText("Medlem"), "person-1");
    await userEvent.type(screen.getByLabelText("Belopp i kronor"), "0");
    await userEvent.type(
      screen.getByLabelText("Vad debiteringen avser"),
      "Felaktig post",
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Registrera debiteringen" }),
    );

    await screen.findByText(/positivt belopp/i);
    expect(
      screen.getByLabelText<HTMLInputElement>("Vad debiteringen avser").value,
    ).toBe("Felaktig post");
  });
});

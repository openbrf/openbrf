import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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
const correctCharge = vi.fn();

vi.mock("./charges-api", () => ({
  VAT_TREATMENTS: ["EXEMPT", "RATE"],
  recordCharge: (input: unknown) => recordCharge(input),
  correctCharge: (chargeId: string, input: unknown) =>
    correctCharge(chargeId, input),
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

describe("the amount", () => {
  async function recordWith(amount: string): Promise<void> {
    panel();
    await userEvent.selectOptions(screen.getByLabelText("Medlem"), "person-1");
    await userEvent.type(screen.getByLabelText("Belopp i kronor"), amount);
    await userEvent.type(
      screen.getByLabelText("Vad debiteringen avser"),
      "Byte av lås",
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Registrera debiteringen" }),
    );
  }

  it("reads an amount typed the Swedish way", async () => {
    // The way the screens print an amount, and what a Swedish phone offers.
    await recordWith("1 234,50");

    expect(recordCharge).toHaveBeenCalledWith(
      expect.objectContaining({ amount: "1234.50" }),
    );
  });

  it("says at the field what is wrong with an amount, and sends nothing", async () => {
    // A third decimal is a figure nobody can have meant; the server would
    // refuse it with a sentence about the whole form.
    await recordWith("12,345");

    expect(recordCharge).not.toHaveBeenCalled();
    const field = screen.getByLabelText("Belopp i kronor");
    expect(field.getAttribute("aria-invalid")).toBe("true");
    expect(screen.getByRole("alert").textContent).toMatch(/två decimaler/u);
  });
});

describe("two people the register holds the same way", () => {
  it("tells them apart by the day each of them moved in", async () => {
    /*
     * A father and a son, one name, one flat. The option has to distinguish
     * them: charging the wrong one puts a sum on a member it was not for, and
     * two identical rows give a board no way to avoid it.
     */
    render(
      <RecordChargePanel
        parties={{
          persons: [
            {
              personId: "bo-elder",
              name: "Bo Ekwall",
              apartment: "Storgatan 12 1602",
              movedInOn: "2019-03-01",
              ambiguous: true,
            },
            {
              personId: "bo-younger",
              name: "Bo Ekwall",
              apartment: "Storgatan 12 1602",
              movedInOn: "2026-01-15",
              ambiguous: true,
            },
          ],
          apartments: [],
        }}
        today="2026-06-01"
        onRecorded={() => undefined}
      />,
    );

    const options = screen.getAllByRole("option").map((o) => o.textContent);
    expect(options).toContain(
      "Bo Ekwall - Storgatan 12 1602 (inflyttad 2019-03-01)",
    );
    expect(options).toContain(
      "Bo Ekwall - Storgatan 12 1602 (inflyttad 2026-01-15)",
    );
    // Substituted, not the raw key: this option is interpolated.
    expect(options.join("")).not.toContain("{{");
  });

  it("leaves an unambiguous option short", () => {
    // The date is added only where it is needed; on every row it would push the
    // thing a board is reading off the end of the line.
    panel();

    expect(screen.getAllByRole("option").map((o) => o.textContent)).toContain(
      "Astrid Vallin - Storgatan 12 1001",
    );
  });
});

describe("the hand-over date", () => {
  it("cannot be offered before the charge it is the basis for", async () => {
    /*
     * The server refuses a basis that reached the economic manager before the
     * charge was made, so the form does not invite one. The bound follows the
     * charge date rather than being fixed at today: a charge is dated back, and
     * the hand-over then belongs on or after that day.
     */
    panel();

    const handedOver = screen.getByLabelText(/Skickat till ekonomisk/);
    expect(handedOver.getAttribute("min")).toBe("2026-06-01");
    expect(handedOver.getAttribute("max")).toBe("2026-06-01");

    fireEvent.change(screen.getByLabelText("Debiteringsdatum"), {
      target: { value: "2026-05-04" },
    });

    expect(handedOver.getAttribute("min")).toBe("2026-05-04");
    expect(handedOver.getAttribute("max")).toBe("2026-06-01");
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

  it("says at the field that it cannot read a rate, and sends nothing", async () => {
    /*
     * "25,5" is not a whole percentage. Sent as Number("25,5"), NaN went over
     * the wire as null and the server asked for a rate the board had typed.
     */
    panel();

    await userEvent.selectOptions(screen.getByLabelText("Medlem"), "person-1");
    await userEvent.type(screen.getByLabelText("Belopp i kronor"), "1000.00");
    await userEvent.type(
      screen.getByLabelText("Vad debiteringen avser"),
      "Uthyrd parkeringsplats",
    );
    await userEvent.selectOptions(screen.getByLabelText("Moms"), "RATE");
    await userEvent.type(screen.getByLabelText("Sats i procent"), "25,5");
    await userEvent.click(
      screen.getByRole("button", { name: "Registrera debiteringen" }),
    );

    expect(recordCharge).not.toHaveBeenCalled();
    const field = screen.getByLabelText("Sats i procent");
    expect(field.getAttribute("aria-invalid")).toBe("true");
    expect(screen.getByRole("alert").textContent).toMatch(/helt procenttal/u);
  });
});

describe("a correction", () => {
  it("says it is saving while the correction is on its way", async () => {
    // The button is disabled meanwhile, and a disabled button that still
    // reads "Save" tells the board nothing about why it does not answer.
    correctCharge.mockReturnValue(new Promise(() => undefined));
    render(
      <RecordChargePanel
        parties={PARTIES}
        today="2026-06-01"
        onRecorded={() => undefined}
        correcting={{
          chargeId: "charge-1",
          chargedOn: "2026-03-05",
          chargedTo: {
            kind: "apartment",
            apartmentId: "apartment-1",
            apartment: { state: "visible", label: "Storgatan 12 1002" },
          },
          amount: "450.00",
          vatTreatment: "EXEMPT",
          vatRatePercent: null,
          reason: "Nyckel till cykelrummet",
          handedToManagerOn: null,
        }}
      />,
    );

    await userEvent.click(
      screen.getByRole("button", { name: "Spara rättelsen" }),
    );

    expect(
      await screen.findByRole("button", { name: "Sparar rättelsen" }),
    ).toBeTruthy();
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

describe("while a charge is being recorded", () => {
  /** Holds the request open, so the form is observed mid-save. */
  function holdRequest(): (outcome: unknown) => void {
    let settle: (outcome: unknown) => void = () => undefined;
    recordCharge.mockReturnValue(
      new Promise((resolve) => {
        settle = resolve;
      }),
    );
    return (outcome) => {
      settle(outcome);
    };
  }

  const OUTCOMES = [
    [
      "once the charge is stored",
      { ok: true, value: { chargeId: "charge-1" } },
    ],
    [
      "when the charge is refused",
      { ok: false, failure: { status: 422, reason: "amount-not-positive" } },
    ],
  ] as const;

  it("locks the form, so nothing typed is lost when the amount and reason are cleared", async () => {
    const user = userEvent.setup();
    const settle = holdRequest();
    panel();

    const amount = screen.getByLabelText<HTMLInputElement>("Belopp i kronor");
    const reason = screen.getByLabelText<HTMLInputElement>(
      "Vad debiteringen avser",
    );
    await user.selectOptions(screen.getByLabelText("Medlem"), "person-1");
    await user.type(amount, "450.00");
    await user.type(reason, "Nyckel");
    expect(amount.matches(":disabled")).toBe(false);

    await user.click(
      screen.getByRole("button", { name: "Registrera debiteringen" }),
    );

    // The request is in flight: the fields refuse input rather than taking it
    // and dropping it once the charge is stored.
    await waitFor(() => {
      expect(amount.matches(":disabled")).toBe(true);
    });
    expect(reason.matches(":disabled")).toBe(true);
    expect(screen.getByLabelText("Medlem").matches(":disabled")).toBe(true);
    await user.type(amount, "9");
    await user.type(reason, "x");
    expect(amount.value).toBe("450.00");
    expect(reason.value).toBe("Nyckel");

    settle({ ok: true, value: { chargeId: "charge-1" } });

    await waitFor(() => {
      expect(amount.matches(":disabled")).toBe(false);
    });
    expect(amount.value).toBe("");
    expect(reason.value).toBe("");
  });

  it.each(OUTCOMES)(
    "keeps focus in the reason field after Enter, %s",
    async (_case, outcome) => {
      const user = userEvent.setup();
      const settle = holdRequest();
      panel();

      const reason = screen.getByLabelText<HTMLInputElement>(
        "Vad debiteringen avser",
      );
      await user.selectOptions(screen.getByLabelText("Medlem"), "person-1");
      await user.type(screen.getByLabelText("Belopp i kronor"), "450.00");
      await user.type(reason, "Nyckel{Enter}");

      await waitFor(() => {
        expect(reason.matches(":disabled")).toBe(true);
      });
      // A browser drops focus to the page when the focused control is
      // disabled; jsdom leaves it where it was. So the hand-back is watched
      // as well as the outcome.
      const refocus = vi.spyOn(reason, "focus");

      settle(outcome);

      await waitFor(() => {
        expect(reason.matches(":disabled")).toBe(false);
      });
      expect(refocus).toHaveBeenCalledTimes(1);
      expect(document.activeElement).toBe(reason);
    },
  );

  it("leaves focus where the user moved it while the charge was being recorded", async () => {
    const user = userEvent.setup();
    const settle = holdRequest();
    render(
      <>
        <input aria-label="Utanför formuläret" />
        <RecordChargePanel
          parties={PARTIES}
          today="2026-06-01"
          onRecorded={() => undefined}
        />
      </>,
    );

    const reason = screen.getByLabelText<HTMLInputElement>(
      "Vad debiteringen avser",
    );
    await user.selectOptions(screen.getByLabelText("Medlem"), "person-1");
    await user.type(screen.getByLabelText("Belopp i kronor"), "450.00");
    await user.type(reason, "Nyckel{Enter}");
    await waitFor(() => {
      expect(reason.matches(":disabled")).toBe(true);
    });

    const outside = screen.getByLabelText("Utanför formuläret");
    outside.focus();

    settle({ ok: true, value: { chargeId: "charge-1" } });

    await waitFor(() => {
      expect(reason.matches(":disabled")).toBe(false);
    });
    expect(document.activeElement).toBe(outside);
  });

  it("hands focus back to the submit button when a browser leaves it unfocused", async () => {
    const user = userEvent.setup();
    panel();

    await user.selectOptions(screen.getByLabelText("Medlem"), "person-1");
    await user.type(screen.getByLabelText("Belopp i kronor"), "450.00");
    await user.type(screen.getByLabelText("Vad debiteringen avser"), "Nyckel");
    // Safari and macOS Firefox: pressing a button does not focus it.
    (document.activeElement as HTMLElement).blur();
    expect(document.activeElement).toBe(document.body);

    const submit = screen.getByRole("button", {
      name: "Registrera debiteringen",
    });
    (submit.closest("form") as HTMLFormElement).requestSubmit(submit);

    await waitFor(() => {
      expect(
        screen.getByLabelText<HTMLInputElement>("Belopp i kronor").value,
      ).toBe("");
    });
    expect(document.activeElement).toBe(submit);
  });
});

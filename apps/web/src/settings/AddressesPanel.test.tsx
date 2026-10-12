import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import "../i18n";
import { AddressesPanel } from "./AddressesPanel";

/**
 * Adding an address.
 *
 * Once the address is stored the form is cleared for the next one. So what a
 * board member types while the request runs would be wiped without a word if
 * the fields stayed open; the form refuses it instead, and hands focus back
 * when it opens again.
 */

const createAddress = vi.fn();

vi.mock("../api/instance", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/instance")>()),
  createAddress: (input: unknown) => createAddress(input),
}));

/** Holds the request open, so the form is observed mid-save. */
function holdRequest(): (outcome: unknown) => void {
  let settle: (outcome: unknown) => void = () => undefined;
  createAddress.mockReturnValue(
    new Promise((resolve) => {
      settle = resolve;
    }),
  );
  return (outcome) => {
    settle(outcome);
  };
}

const OUTCOMES = [
  ["once the address is stored", { ok: true, value: { id: "address-1" } }],
  [
    "when the address is refused",
    { ok: false, failure: { status: 409, reason: "address-exists" } },
  ],
] as const;

function panel(): void {
  render(<AddressesPanel addresses={[]} onChanged={() => undefined} />);
}

beforeEach(() => {
  createAddress.mockReset();
});

describe("while an address is being added", () => {
  it("locks the form, so nothing typed is lost when the fields are cleared", async () => {
    const user = userEvent.setup();
    const settle = holdRequest();
    panel();

    const street = screen.getByLabelText<HTMLInputElement>("Gata");
    const number = screen.getByLabelText<HTMLInputElement>("Nummer");
    const postalCode = screen.getByLabelText<HTMLInputElement>("Postnummer");
    const city = screen.getByLabelText<HTMLInputElement>("Ort");
    await user.type(street, "Storgatan");
    await user.type(number, "12");
    await user.type(postalCode, "11122");
    await user.type(city, "Stockholm");
    expect(street.matches(":disabled")).toBe(false);

    await user.click(screen.getByRole("button", { name: "Lägg till adress" }));

    // The request is in flight: the fields refuse input rather than taking it
    // and dropping it once the address is stored.
    await waitFor(() => {
      expect(street.matches(":disabled")).toBe(true);
    });
    expect(number.matches(":disabled")).toBe(true);
    expect(postalCode.matches(":disabled")).toBe(true);
    expect(city.matches(":disabled")).toBe(true);
    await user.type(street, "x");
    await user.type(city, "y");
    expect(street.value).toBe("Storgatan");
    expect(city.value).toBe("Stockholm");

    settle({ ok: true, value: { id: "address-1" } });

    await waitFor(() => {
      expect(street.matches(":disabled")).toBe(false);
    });
    expect(street.value).toBe("");
    expect(number.value).toBe("");
    expect(postalCode.value).toBe("");
    expect(city.value).toBe("");
  });

  it.each(OUTCOMES)(
    "keeps focus in the city field after Enter, %s",
    async (_case, outcome) => {
      const user = userEvent.setup();
      const settle = holdRequest();
      panel();

      const city = screen.getByLabelText<HTMLInputElement>("Ort");
      await user.type(screen.getByLabelText("Gata"), "Storgatan");
      await user.type(screen.getByLabelText("Nummer"), "12");
      await user.type(screen.getByLabelText("Postnummer"), "11122");
      await user.type(city, "Stockholm{Enter}");

      await waitFor(() => {
        expect(city.matches(":disabled")).toBe(true);
      });
      // A browser drops focus to the page when the focused control is
      // disabled; jsdom leaves it where it was. So the hand-back is watched
      // as well as the outcome.
      const refocus = vi.spyOn(city, "focus");

      settle(outcome);

      // The hand-back runs in an effect after the field is enabled again, so it is
      // awaited together with the enabled state.
      await waitFor(() => {
        expect(city.matches(":disabled")).toBe(false);
        expect(refocus).toHaveBeenCalledTimes(1);
        expect(document.activeElement).toBe(city);
      });
    },
  );
});

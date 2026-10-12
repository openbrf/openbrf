import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import "../i18n";
import { PlaceKeyOrderPanel } from "./PlaceKeyOrderPanel";

/**
 * The form that orders a key or a tag.
 *
 * It resets the kind, the count and the note once the order is in. Only the send
 * button used to be disabled while the request ran, so what a resident went on
 * typing in the meantime was wiped without a word. The fields are locked for the
 * length of the request instead, and focus is handed back when they open again.
 */

const placeKeyOrder = vi.fn();

vi.mock("../api/key-orders", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/key-orders")>()),
  placeKeyOrder: (input: unknown) => placeKeyOrder(input),
}));

const APARTMENT = {
  id: "apartment-1201",
  number: "1201",
  address: "Storgatan 12",
};

function panel(): void {
  render(
    <PlaceKeyOrderPanel apartments={[APARTMENT]} onPlaced={() => undefined} />,
  );
}

beforeEach(() => {
  placeKeyOrder.mockReset();
});

describe("while an order is being placed", () => {
  /** Holds the request open, so the form is observed mid-save. */
  function holdRequest(): (outcome: unknown) => void {
    let settle: (outcome: unknown) => void = () => undefined;
    placeKeyOrder.mockReturnValue(
      new Promise((resolve) => {
        settle = resolve;
      }),
    );
    return (outcome) => {
      settle(outcome);
    };
  }

  const OUTCOMES = [
    ["once the order is in", { ok: true, value: { id: "key-1" } }],
    [
      "when the order is refused",
      { ok: false, failure: { status: 422, reason: "invalid-body" } },
    ],
  ] as const;

  it("locks the form, so nothing typed is lost when the fields are reset", async () => {
    const user = userEvent.setup();
    const settle = holdRequest();
    panel();

    const quantity = screen.getByLabelText<HTMLInputElement>("Hur många");
    const note = screen.getByLabelText<HTMLTextAreaElement>(
      "Vilken dörr, eller vad den ska användas till",
    );
    await user.selectOptions(screen.getByLabelText("Vad du behöver"), "TAG");
    await user.clear(quantity);
    await user.type(quantity, "3");
    await user.type(note, "Cykelrummet");
    expect(note.matches(":disabled")).toBe(false);

    await user.click(
      screen.getByRole("button", { name: "Skicka beställningen" }),
    );

    await waitFor(() => {
      expect(note.matches(":disabled")).toBe(true);
    });
    expect(quantity.matches(":disabled")).toBe(true);
    expect(screen.getByLabelText("Vad du behöver").matches(":disabled")).toBe(
      true,
    );
    await user.type(note, "x");
    await user.type(quantity, "5");
    expect(note.value).toBe("Cykelrummet");
    expect(quantity.value).toBe("3");

    settle({ ok: true, value: { id: "key-1" } });

    await waitFor(() => {
      expect(note.matches(":disabled")).toBe(false);
    });
    expect(note.value).toBe("");
    expect(quantity.value).toBe("1");
    expect(
      screen.getByLabelText<HTMLSelectElement>("Vad du behöver").value,
    ).toBe("KEY");
  });

  it.each(OUTCOMES)(
    "keeps focus in the count field after Enter, %s",
    async (_case, outcome) => {
      const user = userEvent.setup();
      const settle = holdRequest();
      panel();

      const quantity = screen.getByLabelText<HTMLInputElement>("Hur många");
      // What Enter does in a number field in a browser. user-event only
      // submits on Enter from the text-like types, so the form is sent the way
      // the browser sends it: with focus in the field and no submitter.
      await user.click(quantity);
      (quantity.form as HTMLFormElement).requestSubmit();

      await waitFor(() => {
        expect(quantity.matches(":disabled")).toBe(true);
      });
      // A browser drops focus to the page when the focused control is
      // disabled; jsdom leaves it where it was. So the hand-back is watched
      // as well as the outcome.
      const refocus = vi.spyOn(quantity, "focus");

      settle(outcome);

      // The hand-back runs in an effect after the field is enabled again, so it is
      // awaited together with the enabled state.
      await waitFor(() => {
        expect(quantity.matches(":disabled")).toBe(false);
        expect(refocus).toHaveBeenCalledTimes(1);
        expect(document.activeElement).toBe(quantity);
      });
    },
  );
});

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import "../i18n";
import { ApplyForSubletPanel } from "./ApplyForSubletPanel";

/**
 * Applying to let one's apartment in andra hand.
 *
 * Once the application is sent the form is cleared. So what a member types
 * while the request runs would be wiped without a word if the fields stayed
 * open; the form refuses it instead, and hands focus back when it opens again.
 */

const applyForSublet = vi.fn();

vi.mock("../api/sublets", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/sublets")>()),
  applyForSublet: (input: unknown) => applyForSublet(input),
}));

const APARTMENTS = [
  { id: "apartment-1201", number: "1201", address: "Storgatan 12" },
];

/** Holds the request open, so the form is observed mid-save. */
function holdRequest(): (outcome: unknown) => void {
  let settle: (outcome: unknown) => void = () => undefined;
  applyForSublet.mockReturnValue(
    new Promise((resolve) => {
      settle = resolve;
    }),
  );
  return (outcome) => {
    settle(outcome);
  };
}

const OUTCOMES = [
  ["once the application is sent", { ok: true, value: { id: "sublet-1" } }],
  [
    "when the application is refused",
    { ok: false, failure: { status: 422, reason: "invalid-body" } },
  ],
] as const;

function panel(): void {
  render(
    <ApplyForSubletPanel apartments={APARTMENTS} onApplied={() => undefined} />,
  );
}

beforeEach(() => {
  applyForSublet.mockReset();
});

describe("while an application is being sent", () => {
  it("locks the form, so nothing typed is lost when the fields are cleared", async () => {
    const user = userEvent.setup();
    const settle = holdRequest();
    panel();

    const from = screen.getByLabelText<HTMLInputElement>("Från");
    const to = screen.getByLabelText<HTMLInputElement>("Till");
    const reason = screen.getByLabelText<HTMLTextAreaElement>(
      "Varför du vill hyra ut",
    );
    fireEvent.change(from, { target: { value: "2029-02-01" } });
    fireEvent.change(to, { target: { value: "2029-08-31" } });
    await user.type(reason, "Provbo på annan ort");
    expect(reason.matches(":disabled")).toBe(false);

    await user.click(screen.getByRole("button", { name: "Skicka ansökan" }));

    // The request is in flight: the fields refuse input rather than taking it
    // and dropping it once the application is sent.
    await waitFor(() => {
      expect(reason.matches(":disabled")).toBe(true);
    });
    expect(from.matches(":disabled")).toBe(true);
    expect(to.matches(":disabled")).toBe(true);
    expect(screen.getByLabelText("Lägenhet").matches(":disabled")).toBe(true);
    await user.type(reason, "x");
    expect(reason.value).toBe("Provbo på annan ort");

    settle({ ok: true, value: { id: "sublet-1" } });

    await waitFor(() => {
      expect(reason.matches(":disabled")).toBe(false);
    });
    expect(from.value).toBe("");
    expect(to.value).toBe("");
    expect(reason.value).toBe("");
  });

  it.each(OUTCOMES)(
    "keeps focus in the end date after Enter, %s",
    async (_case, outcome) => {
      const user = userEvent.setup();
      const settle = holdRequest();
      panel();

      const to = screen.getByLabelText<HTMLInputElement>("Till");
      fireEvent.change(screen.getByLabelText("Från"), {
        target: { value: "2029-02-01" },
      });
      await user.type(
        screen.getByLabelText("Varför du vill hyra ut"),
        "Provbo på annan ort",
      );
      fireEvent.change(to, { target: { value: "2029-08-31" } });
      // Enter in a field sends the form through the button that sits outside
      // it; jsdom does not follow that association, so the form is sent the
      // way the browser does once it has.
      to.focus();
      (to.closest("form") as HTMLFormElement).requestSubmit();

      await waitFor(() => {
        expect(to.matches(":disabled")).toBe(true);
      });
      // A browser drops focus to the page when the focused control is
      // disabled; jsdom leaves it where it was. So the hand-back is watched
      // as well as the outcome.
      const refocus = vi.spyOn(to, "focus");

      settle(outcome);

      // The hand-back runs in an effect after the field is enabled again, so it is
      // awaited together with the enabled state.
      await waitFor(() => {
        expect(to.matches(":disabled")).toBe(false);
        expect(refocus).toHaveBeenCalledTimes(1);
        expect(document.activeElement).toBe(to);
      });
    },
  );
});

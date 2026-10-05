import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import "../i18n";
import { SubmitMotionPanel } from "./SubmitMotionPanel";

/**
 * The form that puts a motion to the general meeting.
 *
 * It clears both fields once the motion is in. Only the send button used to be
 * disabled while the request ran, so what a member went on typing in the
 * meantime was wiped without a word. The fields are locked for the length of the
 * request instead, and focus is handed back when they open again.
 */

const submitMotion = vi.fn();

vi.mock("../api/motions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/motions")>()),
  submitMotion: (input: unknown) => submitMotion(input),
}));

function panel(): void {
  render(<SubmitMotionPanel deadline={null} onSubmitted={() => undefined} />);
}

beforeEach(() => {
  submitMotion.mockReset();
});

describe("while a motion is being sent", () => {
  /** Holds the request open, so the form is observed mid-save. */
  function holdRequest(): (outcome: unknown) => void {
    let settle: (outcome: unknown) => void = () => undefined;
    submitMotion.mockReturnValue(
      new Promise((resolve) => {
        settle = resolve;
      }),
    );
    return (outcome) => {
      settle(outcome);
    };
  }

  const OUTCOMES = [
    ["once the motion is in", { ok: true, value: { id: "motion-1" } }],
    [
      "when the motion is refused",
      { ok: false, failure: { status: 422, reason: "invalid-body" } },
    ],
  ] as const;

  it("locks the form, so nothing typed is lost when the fields are cleared", async () => {
    const user = userEvent.setup();
    const settle = holdRequest();
    panel();

    const title = screen.getByLabelText<HTMLInputElement>(
      "Vad du föreslår, på en rad",
    );
    const body = screen.getByLabelText<HTMLTextAreaElement>("Förslaget");
    await user.type(title, "Laddstolpar");
    await user.type(body, "Utred kostnaden.");
    expect(title.matches(":disabled")).toBe(false);

    await user.click(screen.getByRole("button", { name: "Skicka motionen" }));

    await waitFor(() => {
      expect(title.matches(":disabled")).toBe(true);
    });
    expect(body.matches(":disabled")).toBe(true);
    await user.type(title, "x");
    await user.type(body, "y");
    expect(title.value).toBe("Laddstolpar");
    expect(body.value).toBe("Utred kostnaden.");

    settle({ ok: true, value: { id: "motion-1" } });

    await waitFor(() => {
      expect(title.matches(":disabled")).toBe(false);
    });
    expect(title.value).toBe("");
    expect(body.value).toBe("");
  });

  it.each(OUTCOMES)(
    "keeps focus in the title field after Enter, %s",
    async (_case, outcome) => {
      const user = userEvent.setup();
      const settle = holdRequest();
      panel();

      const title = screen.getByLabelText<HTMLInputElement>(
        "Vad du föreslår, på en rad",
      );
      await user.type(screen.getByLabelText("Förslaget"), "Utred kostnaden.");
      await user.type(title, "Laddstolpar{Enter}");

      await waitFor(() => {
        expect(title.matches(":disabled")).toBe(true);
      });
      // A browser drops focus to the page when the focused control is
      // disabled; jsdom leaves it where it was. So the hand-back is watched
      // as well as the outcome.
      const refocus = vi.spyOn(title, "focus");

      settle(outcome);

      await waitFor(() => {
        expect(title.matches(":disabled")).toBe(false);
      });
      expect(refocus).toHaveBeenCalledTimes(1);
      expect(document.activeElement).toBe(title);
    },
  );
});

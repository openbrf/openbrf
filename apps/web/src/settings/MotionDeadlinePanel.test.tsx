import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import "../i18n";
import { MotionDeadlinePanel } from "./MotionDeadlinePanel";

/**
 * The bylaws clause for motions, as a board transcribes it.
 *
 * The clause is a month and a day, typed into two number inputs. What this file
 * pins down is the reading of those fields: the browser hands back text, so the
 * panel decides what "1e1" and "" mean before the API ever sees them - and both
 * of those decisions can be got wrong in a way that stores a date nobody
 * entered and that nothing on the screen afterwards would show.
 */

const saveMotionDeadline = vi.fn();

vi.mock("../api/motions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/motions")>()),
  saveMotionDeadline: (input: unknown) => saveMotionDeadline(input),
}));

beforeEach(() => {
  saveMotionDeadline.mockReset().mockResolvedValue({
    ok: true,
    value: { motionDeadline: { month: 1, day: 31 } },
  });
});

const monthField = (): HTMLElement => screen.getByLabelText("Månad");
const dayField = (): HTMLElement => screen.getByLabelText("Dag");
const saveButton = (): HTMLElement =>
  screen.getByRole("button", { name: "Spara" });

/** Types into a number field the way the browser hands the value over. */
const enter = (field: HTMLElement, value: string): void => {
  fireEvent.change(field, { target: { value } });
};

/**
 * The form itself, which the save button sits outside of and submits by id.
 *
 * Reached here because pressing Enter in a field submits it without going near
 * the button, so the guard inside onSubmit is the one that answers that.
 */
const deadlineForm = (): HTMLFormElement => {
  const element = document.getElementById("motion-deadline");
  if (!(element instanceof HTMLFormElement)) {
    throw new Error("the motion deadline form is not in the document");
  }
  return element;
};

describe("the clause the board types in", () => {
  it("stores the whole number in each field", async () => {
    /*
     * A number input accepts exponent notation, so "1e1" is what the field hands
     * back when somebody enters it - and it means 10. Reading only the leading
     * digits stores 1: a valid date, accepted by the API, and not the day the
     * bylaws name.
     */
    render(<MotionDeadlinePanel motionDeadline={null} />);

    enter(monthField(), "1e1");
    enter(dayField(), "3e1");
    await userEvent.click(saveButton());

    await waitFor(() => {
      expect(saveMotionDeadline).toHaveBeenCalledWith({
        motionDeadline: { month: 10, day: 30 },
      });
    });
  });

  it("refuses half a deadline rather than reading a blank field as a number", async () => {
    /*
     * The empty pair is what says the bylaws set no deadline, and one field on
     * its own is a rule nothing can resolve to a date. Both turn on what a blank
     * field converts to: 0 is a number and not a month, so a reading that let it
     * through would send the API a 0 to refuse, for a field the board filled in
     * correctly.
     */
    render(<MotionDeadlinePanel motionDeadline={null} />);

    enter(monthField(), "1");
    expect(saveButton()).toHaveProperty("disabled", true);

    fireEvent.submit(deadlineForm());
    expect(saveMotionDeadline).not.toHaveBeenCalled();

    enter(dayField(), "31");
    expect(saveButton()).toHaveProperty("disabled", false);

    await userEvent.click(saveButton());
    await waitFor(() => {
      expect(saveMotionDeadline).toHaveBeenCalledWith({
        motionDeadline: { month: 1, day: 31 },
      });
    });
  });

  it("clears the clause when both fields are emptied", async () => {
    // Leaving it empty is a complete answer: the bylaws say nothing about
    // motions, and the screens then say so rather than naming a date.
    render(<MotionDeadlinePanel motionDeadline={{ month: 1, day: 31 }} />);

    enter(monthField(), "");
    enter(dayField(), "");
    await userEvent.click(saveButton());

    await waitFor(() => {
      expect(saveMotionDeadline).toHaveBeenCalledWith({ motionDeadline: null });
    });
  });
});

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import "../i18n";
import { RetentionPanel } from "./RetentionPanel";

/**
 * How long service data is kept after a move-out.
 *
 * The statutory notice on this panel is not a disclaimer. The member register
 * and the audit log are append-only in the database and exempt from purging
 * (EFL 5 kap. via BRL 9 kap.), so a board that reads this screen as a delete
 * button will answer a resident's erasure request wrongly. The notice therefore
 * has to be on screen whatever else the panel is saying.
 */

const saveRetention = vi.fn();

vi.mock("../api/instance", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/instance")>()),
  saveRetention: (input: unknown) => saveRetention(input),
}));

const statutoryNotice = () => screen.queryByText(/omfattas inte/i);
const purgeNotice = () => screen.queryByText(/körs varje natt/i);

beforeEach(() => {
  saveRetention.mockReset().mockResolvedValue({
    ok: true,
    value: { daysAfterMoveOut: 400 },
  });
});

describe("the statutory notice", () => {
  it("is on screen before anything is saved", () => {
    render(<RetentionPanel daysAfterMoveOut={365} />);

    expect(statutoryNotice()).toBeTruthy();
  });

  it("says the erasure happens by itself, and what suspends it", () => {
    // The number used to compute a date and nothing else. A board reading it
    // now has to know that a job acts on it, and that a legal hold is the one
    // thing that stops it for a named person.
    render(<RetentionPanel daysAfterMoveOut={365} />);

    expect(purgeNotice()).toBeTruthy();
    expect(screen.getByText(/rättsligt bevarandekrav/i)).toBeTruthy();
  });

  it("stays after a successful save, beside the confirmation", async () => {
    // Nothing remounts this panel, so a notice replaced by the confirmation
    // would stay gone for the rest of the session.
    const session = userEvent.setup();
    render(<RetentionPanel daysAfterMoveOut={365} />);

    await session.click(screen.getByRole("button", { name: /^spara$/i }));

    await waitFor(() => {
      expect(screen.getByText("Sparat")).toBeTruthy();
    });
    expect(statutoryNotice()).toBeTruthy();
  });

  it("stays when the save is refused", async () => {
    saveRetention.mockResolvedValue({
      ok: false,
      failure: { status: 400, reason: "invalid-body" },
    });

    const session = userEvent.setup();
    render(<RetentionPanel daysAfterMoveOut={365} />);

    await session.click(screen.getByRole("button", { name: /^spara$/i }));

    await waitFor(() => {
      expect(
        screen.getByText(/^Välj mellan 30 och 3650 dagar\.$/),
      ).toBeTruthy();
    });
    expect(statutoryNotice()).toBeTruthy();
  });
});

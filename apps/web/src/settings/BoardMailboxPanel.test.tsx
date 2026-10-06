import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import "../i18n";
import type { BoardMailboxSettings } from "../api/instance";
import { BoardMailboxPanel } from "./BoardMailboxPanel";

/**
 * The form for the board's shared mailbox.
 *
 * The password is the part worth guarding while a save runs: it is cleared once
 * the save is stored, so anything typed into the form in the meantime would be
 * wiped without a word unless the form refuses input until the request is done.
 */

const saveBoardMailbox = vi.fn();

vi.mock("../api/instance", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/instance")>()),
  saveBoardMailbox: (input: unknown) => saveBoardMailbox(input),
}));

const CONFIGURED: BoardMailboxSettings = {
  address: "styrelsen@exempel.se",
  host: "pop.exempel.se",
  port: 995,
  secure: true,
  user: "styrelsen",
  passwordSet: true,
  configured: true,
};

const save = async (session: ReturnType<typeof userEvent.setup>) => {
  await session.click(screen.getByRole("button", { name: /^spara$/i }));
};

beforeEach(() => {
  saveBoardMailbox
    .mockReset()
    .mockResolvedValue({ ok: true, value: CONFIGURED });
});

describe("while the board mailbox is being saved", () => {
  /** Holds the request open, so the form is observed mid-save. */
  function holdRequest(): (outcome: unknown) => void {
    let settle: (outcome: unknown) => void = () => undefined;
    saveBoardMailbox.mockReturnValue(
      new Promise((resolve) => {
        settle = resolve;
      }),
    );
    return (outcome) => {
      settle(outcome);
    };
  }

  const OUTCOMES = [
    ["once it is stored", { ok: true, value: CONFIGURED }],
    [
      "when it is refused",
      { ok: false, failure: { status: 500, reason: "unknown" } },
    ],
  ] as const;

  it("locks the form, so nothing typed is lost when the password is cleared", async () => {
    const session = userEvent.setup();
    const settle = holdRequest();
    render(<BoardMailboxPanel value={CONFIGURED} />);

    const secret = screen.getByLabelText<HTMLInputElement>(
      /^lösenord till brevlådan/i,
    );
    const other = screen.getByLabelText<HTMLInputElement>(
      /^användarnamn till brevlådan/i,
    );
    await session.type(secret, "hemligt");
    expect(secret.matches(":disabled")).toBe(false);

    await save(session);

    // The request is in flight: the fields refuse input rather than taking it
    // and dropping it once the save is stored.
    await waitFor(() => {
      expect(secret.matches(":disabled")).toBe(true);
    });
    expect(other.matches(":disabled")).toBe(true);
    await session.type(secret, "9");
    await session.type(other, "x");
    expect(secret.value).toBe("hemligt");
    expect(other.value).toBe("styrelsen");

    settle({ ok: true, value: CONFIGURED });

    await waitFor(() => {
      expect(secret.matches(":disabled")).toBe(false);
    });
    expect(secret.value).toBe("");
    expect(other.value).toBe("styrelsen");
  });

  it.each(OUTCOMES)(
    "keeps focus in the password field after Enter, %s",
    async (_case, outcome) => {
      const session = userEvent.setup();
      const settle = holdRequest();
      render(<BoardMailboxPanel value={CONFIGURED} />);

      const secret = screen.getByLabelText<HTMLInputElement>(
        /^lösenord till brevlådan/i,
      );
      await session.type(secret, "hemligt{Enter}");

      await waitFor(() => {
        expect(secret.matches(":disabled")).toBe(true);
      });
      // A browser drops focus to the page when the focused control is
      // disabled; jsdom leaves it where it was. So the hand-back is watched
      // as well as the outcome.
      const refocus = vi.spyOn(secret, "focus");

      settle(outcome);

      await waitFor(() => {
        expect(secret.matches(":disabled")).toBe(false);
      });
      // The hand-back runs in a passive effect, which can land just after the
      // field is enabled.
      await waitFor(() => {
        expect(refocus).toHaveBeenCalledTimes(1);
      });
      expect(document.activeElement).toBe(secret);
    },
  );
});

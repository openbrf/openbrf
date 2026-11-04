import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import "../i18n";
import type { IssueDamageCase, QueuedIssue } from "../api/issues";
import { IssueDamageCaseSection } from "./IssueDamageCase";

/**
 * The damage case form on an issue (decision 28): what it sends, that the
 * hold it places is said before it is placed, and that taking the mark off
 * says the hold stays.
 */

const markIssueDamageCase = vi.fn();
const removeIssueDamageCase = vi.fn();

vi.mock("../api/issues", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/issues")>()),
  markIssueDamageCase: (input: unknown) => markIssueDamageCase(input),
  removeIssueDamageCase: (input: unknown) => removeIssueDamageCase(input),
}));

const CLAIM: IssueDamageCase = {
  insurer: "Länsförsäkringar",
  claimNumber: "S-2026-114",
  occurredOn: "2026-10-30",
  cause: "WATER",
};

function issue(damageCase: IssueDamageCase | null): QueuedIssue {
  return {
    id: "issue-1",
    number: 12,
    typeName: "Vattenläcka",
    damageCase,
    legalHoldAt: damageCase === null ? null : "2026-11-01T09:00:00.000Z",
  } as QueuedIssue;
}

beforeEach(() => {
  markIssueDamageCase
    .mockReset()
    .mockResolvedValue({ ok: true, value: issue(CLAIM) });
  removeIssueDamageCase
    .mockReset()
    .mockResolvedValue({ ok: true, value: issue(null) });
});

describe("the damage case form", () => {
  it("says the mark places a legal hold, and sends the claim as written", async () => {
    const session = userEvent.setup();
    const onChanged = vi.fn();
    render(
      <IssueDamageCaseSection issue={issue(null)} onChanged={onChanged} />,
    );

    expect(screen.getByText(/rättsligt bevarandekrav/i)).toBeTruthy();
    const submit = screen.getByRole("button", {
      name: "Markera ärende 12 som skadeärende",
    });
    // Nothing to send until the insurer, the number and the day are there.
    expect(submit).toHaveProperty("disabled", true);

    await session.type(
      screen.getByLabelText("Försäkringsbolag"),
      " Länsförsäkringar ",
    );
    await session.type(screen.getByLabelText("Skadenummer"), "S-2026-114");
    await session.type(screen.getByLabelText("Skadedag"), "2026-10-30");
    await session.selectOptions(screen.getByLabelText("Orsak"), "WATER");
    await session.click(submit);

    await waitFor(() => {
      expect(onChanged).toHaveBeenCalled();
    });
    expect(markIssueDamageCase).toHaveBeenCalledWith({
      issueId: "issue-1",
      damageCase: CLAIM,
      replaces: null,
    });
    expect(screen.getByText("Skadeärendet är sparat.")).toBeTruthy();
  });

  it("holds an edited draft over a mark that changed, and saves from the mark it began from", async () => {
    const session = userEvent.setup();
    const { rerender } = render(
      <IssueDamageCaseSection
        issue={issue(CLAIM)}
        onChanged={() => undefined}
      />,
    );
    await session.clear(screen.getByLabelText("Skadenummer"));
    await session.type(screen.getByLabelText("Skadenummer"), "S-2026-200");

    // Somebody else changes the mark; the queue is read again.
    const theirs = { ...CLAIM, insurer: "If Skadeförsäkring" };
    rerender(
      <IssueDamageCaseSection
        issue={issue(theirs)}
        onChanged={() => undefined}
      />,
    );

    expect(
      screen.getByText(/markeringen ändrades medan du redigerade/i),
    ).toBeTruthy();
    // The edit stays, and cannot be saved over the newer mark.
    expect(
      (screen.getByLabelText("Skadenummer") as HTMLInputElement).value,
    ).toBe("S-2026-200");
    expect(
      screen.getByRole("button", { name: "Spara skadeärendet för ärende 12" }),
    ).toHaveProperty("disabled", true);

    // Nor taken off, which would delete a mark this handler has not seen.
    expect(
      screen.getByRole("button", {
        name: "Ta bort skadeärendemarkeringen från ärende 12",
      }),
    ).toHaveProperty("disabled", true);

    await session.click(
      screen.getByRole("button", { name: "Hämta den nuvarande markeringen" }),
    );
    expect(
      (screen.getByLabelText("Försäkringsbolag") as HTMLInputElement).value,
    ).toBe("If Skadeförsäkring");
    expect(
      screen.queryByText(/markeringen ändrades medan du redigerade/i),
    ).toBeNull();

    await session.type(screen.getByLabelText("Skadenummer"), "9");
    await session.click(
      screen.getByRole("button", { name: "Spara skadeärendet för ärende 12" }),
    );
    await waitFor(() => {
      expect(markIssueDamageCase).toHaveBeenCalledWith({
        issueId: "issue-1",
        damageCase: { ...theirs, claimNumber: "S-2026-1149" },
        replaces: theirs,
      });
    });
  });

  it("says when the API refused a save made from a mark that has changed", async () => {
    markIssueDamageCase.mockResolvedValue({
      ok: false,
      failure: { status: 409, reason: "damage-case-changed" },
    });
    const session = userEvent.setup();
    render(
      <IssueDamageCaseSection
        issue={issue(CLAIM)}
        onChanged={() => undefined}
      />,
    );
    await session.click(
      screen.getByRole("button", { name: "Spara skadeärendet för ärende 12" }),
    );
    await waitFor(() => {
      expect(screen.getByText(/ändrades av någon annan/i)).toBeTruthy();
    });
  });

  it("says the hold stays when the mark comes off", async () => {
    const session = userEvent.setup();
    render(
      <IssueDamageCaseSection
        issue={issue(CLAIM)}
        onChanged={() => undefined}
      />,
    );

    await session.click(
      screen.getByRole("button", {
        name: "Ta bort skadeärendemarkeringen från ärende 12",
      }),
    );

    await waitFor(() => {
      expect(removeIssueDamageCase).toHaveBeenCalledWith({
        issueId: "issue-1",
        replaces: CLAIM,
      });
    });
    expect(
      screen.getByText(/bevarandekravet står kvar tills någon häver det/i),
    ).toBeTruthy();
  });

  it("says why a mark was refused, and clears it once the draft changes", async () => {
    markIssueDamageCase.mockResolvedValue({
      ok: false,
      failure: { status: 422, reason: "personal-identity-number" },
    });
    const session = userEvent.setup();
    render(
      <IssueDamageCaseSection
        issue={issue(CLAIM)}
        onChanged={() => undefined}
      />,
    );

    await session.click(
      screen.getByRole("button", {
        name: "Spara skadeärendet för ärende 12",
      }),
    );
    await waitFor(() => {
      expect(screen.getByText(/personnummer hör inte hemma/i)).toBeTruthy();
    });

    await session.type(screen.getByLabelText("Skadenummer"), "5");
    expect(screen.queryByText(/personnummer hör inte hemma/i)).toBeNull();
  });
});

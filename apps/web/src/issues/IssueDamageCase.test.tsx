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
    });
    expect(screen.getByText("Skadeärendet är sparat.")).toBeTruthy();
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

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState, type ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import "../i18n";
import type { IssueConcernedPerson, QueuedIssue } from "../api/issues";
import { IssueConcernedPersonsSection } from "./IssueConcernedPersons";

/**
 * The list of whom an issue concerns (ADR 0057): it names a person or says the
 * name is protected, records a resident picked by residency, takes one off as
 * a removal asked twice, and offers no removal while a legal hold stands.
 */

const fetchIssueConcernedPersons = vi.fn();
const addIssueConcernedPerson = vi.fn();
const redactIssue = vi.fn();

vi.mock("../api/issues", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/issues")>()),
  fetchIssueConcernedPersons: (issueId: string) =>
    fetchIssueConcernedPersons(issueId),
  addIssueConcernedPerson: (input: unknown) => addIssueConcernedPerson(input),
  redactIssue: (input: unknown) => redactIssue(input),
  fetchIssueApartments: () =>
    Promise.resolve({
      ok: true,
      value: [
        { id: "apartment-1201", address: "Grannvägen 3", number: "1201" },
      ],
    }),
  fetchIssueResidents: () =>
    Promise.resolve({
      ok: true,
      value: [
        { kind: "person", residencyId: "residency-nils", name: "Nils Granne" },
      ],
    }),
}));

const NILS: IssueConcernedPerson = {
  kind: "person",
  id: "record-nils",
  name: "Nils Granne",
};
const SHIELDED: IssueConcernedPerson = { kind: "protected", id: "record-2" };

function issue(legalHoldAt: string | null = null): QueuedIssue {
  return {
    id: "issue-1",
    number: 12,
    typeName: "Störningar",
    legalHoldAt,
  } as QueuedIssue;
}

beforeEach(() => {
  fetchIssueConcernedPersons
    .mockReset()
    .mockResolvedValue({ ok: true, value: [SHIELDED] });
  addIssueConcernedPerson
    .mockReset()
    .mockResolvedValue({ ok: true, value: [SHIELDED, NILS] });
  redactIssue.mockReset().mockResolvedValue({ ok: true, value: undefined });
});

describe("whom an issue concerns", () => {
  it("withholds a protected name, and records the resident picked by residency", async () => {
    const session = userEvent.setup();
    const onChanged = vi.fn();
    render(
      <IssueConcernedPersonsSection issue={issue()} onChanged={onChanged} />,
    );

    expect(
      await screen.findByText("Namnet visas inte (skyddade personuppgifter)"),
    ).toBeTruthy();
    const add = screen.getByRole("button", {
      name: "Störningar: lägg till den valda boende som en person ärendet gäller",
    });
    // Nothing to add until a resident is picked.
    expect(add).toHaveProperty("disabled", true);

    await session.selectOptions(
      screen.getByLabelText("Lägenhet"),
      "apartment-1201",
    );
    await session.selectOptions(
      await screen.findByLabelText("Boende som det gäller"),
      "residency-nils",
    );
    await session.click(add);

    await waitFor(() => {
      expect(onChanged).toHaveBeenCalled();
    });
    expect(addIssueConcernedPerson).toHaveBeenCalledWith({
      issueId: "issue-1",
      residencyId: "residency-nils",
    });
    expect(await screen.findByText("Nils Granne")).toBeTruthy();
  });

  it("takes a person off only when asked twice, and reads the list again", async () => {
    const session = userEvent.setup();
    fetchIssueConcernedPersons.mockResolvedValue({ ok: true, value: [NILS] });
    render(
      <IssueConcernedPersonsSection
        issue={issue()}
        onChanged={() => undefined}
      />,
    );

    await session.click(
      await screen.findByRole("button", {
        name: "Ta bort Nils Granne från dem som ärendet gäller",
      }),
    );
    expect(redactIssue).not.toHaveBeenCalled();
    fetchIssueConcernedPersons.mockResolvedValue({ ok: true, value: [] });
    await session.click(
      screen.getByRole("button", { name: "Ta bort för gott" }),
    );

    expect(redactIssue).toHaveBeenCalledWith({
      issueId: "issue-1",
      redaction: { target: "concernedPerson", id: "record-nils" },
    });
    expect(await screen.findByText("Ingen är antecknad.")).toBeTruthy();
  });

  it("offers no removal while a legal hold stands, and says why", async () => {
    fetchIssueConcernedPersons.mockResolvedValue({ ok: true, value: [NILS] });
    render(
      <IssueConcernedPersonsSection
        issue={issue("2026-11-01T09:00:00.000Z")}
        onChanged={() => undefined}
      />,
    );

    expect(await screen.findByText("Nils Granne")).toBeTruthy();
    expect(
      screen.queryByRole("button", {
        name: "Ta bort Nils Granne från dem som ärendet gäller",
      }),
    ).toBeNull();
    expect(
      screen.getByText(
        "Ärendet har ett rättsligt bevarandekrav, så ingen kan tas bort från listan förrän kravet hävs.",
      ),
    ).toBeTruthy();
  });

  it("says a hold on somebody it concerns refused the removal, and reads the list again", async () => {
    const session = userEvent.setup();
    fetchIssueConcernedPersons.mockResolvedValue({ ok: true, value: [NILS] });
    redactIssue.mockResolvedValue({
      ok: false,
      failure: { status: 409, reason: "legal-hold" },
    });
    render(
      <IssueConcernedPersonsSection
        issue={issue()}
        onChanged={() => undefined}
      />,
    );

    await session.click(
      await screen.findByRole("button", {
        name: "Ta bort Nils Granne från dem som ärendet gäller",
      }),
    );
    await session.click(
      screen.getByRole("button", { name: "Ta bort för gott" }),
    );

    expect(
      await screen.findByText(
        /eller för en person som ärendet gäller, så ingenting kan tas bort/,
      ),
    ).toBeTruthy();
    await waitFor(() => {
      expect(fetchIssueConcernedPersons).toHaveBeenCalledTimes(2);
    });
  });

  it("reads the issue again when a hold placed since it was read refuses the removal", async () => {
    /*
     * Another handler placed a hold on the issue after this screen read it.
     * The hold is on the issue's own row, which the list does not carry, so
     * only the issue read again (the parent's `onChanged`) stops offering the
     * removal and shows why. Here the parent's re-read brings the hold.
     */
    const session = userEvent.setup();
    fetchIssueConcernedPersons.mockResolvedValue({ ok: true, value: [NILS] });
    redactIssue.mockResolvedValue({
      ok: false,
      failure: { status: 409, reason: "legal-hold" },
    });
    const onChanged = vi.fn();
    function Parent(): ReactElement {
      const [shown, setShown] = useState(issue());
      return (
        <IssueConcernedPersonsSection
          issue={shown}
          onChanged={() => {
            onChanged();
            setShown(issue("2026-11-09T09:00:00.000Z"));
          }}
        />
      );
    }
    render(<Parent />);

    await session.click(
      await screen.findByRole("button", {
        name: "Ta bort Nils Granne från dem som ärendet gäller",
      }),
    );
    await session.click(
      screen.getByRole("button", { name: "Ta bort för gott" }),
    );

    expect(
      await screen.findByText(
        "Ärendet har ett rättsligt bevarandekrav, så ingen kan tas bort från listan förrän kravet hävs.",
      ),
    ).toBeTruthy();
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(
      screen.queryByRole("button", {
        name: "Ta bort Nils Granne från dem som ärendet gäller",
      }),
    ).toBeNull();
    // The refusal still says what was refused.
    expect(
      screen.getByText(
        /eller för en person som ärendet gäller, så ingenting kan tas bort/,
      ),
    ).toBeTruthy();
  });

  it("leaves a refusal that is not about the screen being out of date to the list alone", async () => {
    const session = userEvent.setup();
    fetchIssueConcernedPersons.mockResolvedValue({ ok: true, value: [NILS] });
    redactIssue.mockResolvedValue({
      ok: false,
      failure: { status: 400, reason: "invalid-body" },
    });
    const onChanged = vi.fn();
    render(
      <IssueConcernedPersonsSection issue={issue()} onChanged={onChanged} />,
    );

    await session.click(
      await screen.findByRole("button", {
        name: "Ta bort Nils Granne från dem som ärendet gäller",
      }),
    );
    await session.click(
      screen.getByRole("button", { name: "Ta bort för gott" }),
    );

    expect(
      await screen.findByText("Ingenting kunde sparas just nu. Försök igen."),
    ).toBeTruthy();
    expect(onChanged).not.toHaveBeenCalled();
    expect(fetchIssueConcernedPersons).toHaveBeenCalledTimes(1);
  });

  it("reads the list again when the queue hands over a newer read of the issue, so a name newly protected is withheld", async () => {
    fetchIssueConcernedPersons
      .mockReset()
      .mockResolvedValueOnce({ ok: true, value: [NILS] })
      .mockResolvedValue({
        ok: true,
        value: [{ kind: "protected", id: NILS.id }],
      });
    const view = render(
      <IssueConcernedPersonsSection issue={issue()} onChanged={vi.fn()} />,
    );
    expect(await screen.findByText("Nils Granne")).toBeTruthy();

    // The same issue, read again by the queue.
    view.rerender(
      <IssueConcernedPersonsSection issue={issue()} onChanged={vi.fn()} />,
    );

    expect(
      await screen.findByText("Namnet visas inte (skyddade personuppgifter)"),
    ).toBeTruthy();
    expect(screen.queryByText("Nils Granne")).toBeNull();
    expect(fetchIssueConcernedPersons).toHaveBeenCalledTimes(2);
  });

  it("offers a retry when the list could not be read, and shows the list once it can", async () => {
    const session = userEvent.setup();
    fetchIssueConcernedPersons
      .mockReset()
      .mockResolvedValueOnce({
        ok: false,
        failure: { status: 503, reason: "unavailable" },
      })
      .mockResolvedValue({ ok: true, value: [NILS] });
    render(
      <IssueConcernedPersonsSection issue={issue()} onChanged={vi.fn()} />,
    );

    await session.click(
      await screen.findByRole("button", { name: "Försök igen" }),
    );

    expect(await screen.findByText("Nils Granne")).toBeTruthy();
    expect(fetchIssueConcernedPersons).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("button", { name: "Försök igen" })).toBeNull();
  });
});

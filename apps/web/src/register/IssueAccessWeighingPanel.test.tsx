import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import "../i18n";
import { IssueAccessWeighingPanel } from "./IssueAccessWeighingPanel";
import type { IssueAccessWeighing } from "./register-api";

/**
 * The board's art. 15(4) weighing of one issue for one access report (ADR
 * 0057): every text needs a choice before it saves, a reporter's own report
 * offers no leaving out for naming them, one save runs at a time, and a failed
 * save keeps the choices to try again.
 */

const { fetchIssueAccessWeighing, saveIssueAccessWeighing } = vi.hoisted(
  () => ({
    fetchIssueAccessWeighing: vi.fn(),
    saveIssueAccessWeighing: vi.fn(),
  }),
);

vi.mock("./register-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./register-api")>()),
  fetchIssueAccessWeighing,
  saveIssueAccessWeighing,
}));

const CONCERNED: IssueAccessWeighing = {
  issueId: "issue-1",
  number: 52,
  typeName: "Störningar",
  report: "concerned",
  texts: [
    {
      part: "DESCRIPTION",
      id: null,
      writtenAt: "2026-01-07T21:00:00.000Z",
      side: null,
      text: "Jag i 1102 hör musik varje natt.",
      decision: null,
    },
    {
      part: "MESSAGE",
      id: "message-1",
      writtenAt: "2026-01-08T09:00:00.000Z",
      side: "HANDLER",
      text: "Vi har pratat med grannen.",
      decision: "given",
    },
  ],
};

const REPORTER: IssueAccessWeighing = {
  ...CONCERNED,
  report: "reporter",
  texts: [
    {
      part: "NOTE",
      id: "note-1",
      writtenAt: "2026-01-08T09:00:00.000Z",
      side: null,
      text: "Ringde om porten.",
      decision: null,
    },
  ],
};

function renderPanel() {
  const onSaved = vi.fn();
  const onClose = vi.fn();
  render(
    <IssueAccessWeighingPanel
      personId="person-1"
      issueId="issue-1"
      onClose={onClose}
      onSaved={onSaved}
    />,
  );
  return { onSaved, onClose };
}

function saveButton(): HTMLButtonElement {
  return screen.getByRole("button", {
    name: "Spara prövningen",
  }) as HTMLButtonElement;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("the board's weighing of an issue for an access report", () => {
  it("saves only once every text has a choice, and sends each as chosen", async () => {
    fetchIssueAccessWeighing.mockResolvedValue(CONCERNED);
    saveIssueAccessWeighing.mockResolvedValue(CONCERNED);
    const { onSaved } = renderPanel();

    await screen.findByText("Jag i 1102 hör musik varje natt.");
    // The message's earlier weighing stands; the description has none yet.
    expect(saveButton().disabled).toBe(true);
    expect(
      screen.getByText("Välj för varje text innan du sparar."),
    ).toBeTruthy();

    fireEvent.click(
      screen.getAllByRole("radio", {
        name: "Utelämna: det skulle avslöja vem som anmälde ärendet",
      })[0] as HTMLElement,
    );
    expect(saveButton().disabled).toBe(false);
    fireEvent.click(saveButton());

    await waitFor(() => {
      expect(onSaved).toHaveBeenCalledTimes(1);
    });
    expect(saveIssueAccessWeighing).toHaveBeenCalledWith(
      "person-1",
      "issue-1",
      [
        {
          part: "DESCRIPTION",
          id: null,
          withheldBecause: "IDENTIFIES_REPORTER",
        },
        { part: "MESSAGE", id: "message-1", withheldBecause: null },
      ],
    );
  });

  it("offers a reporter's own report no leaving out for naming them", async () => {
    fetchIssueAccessWeighing.mockResolvedValue(REPORTER);
    renderPanel();

    await screen.findByText("Ringde om porten.");
    expect(
      screen.getByRole("radio", {
        name: "Utelämna: det handlar om någon annan",
      }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("radio", {
        name: "Utelämna: det skulle avslöja vem som anmälde ärendet",
      }),
    ).toBeNull();
  });

  it("sends one save at a time, and keeps the choices when a save fails", async () => {
    fetchIssueAccessWeighing.mockResolvedValue(REPORTER);
    let fail: (reason: unknown) => void = () => undefined;
    saveIssueAccessWeighing.mockImplementation(
      () =>
        new Promise((_, reject) => {
          fail = reject;
        }),
    );
    const { onSaved } = renderPanel();

    await screen.findByText("Ringde om porten.");
    fireEvent.click(screen.getByRole("radio", { name: "Lämna ut" }));
    fireEvent.click(saveButton());
    fireEvent.click(screen.getByRole("button", { name: "Sparar..." }));
    expect(saveIssueAccessWeighing).toHaveBeenCalledTimes(1);

    fail(new Error("offline"));
    await screen.findByText("Prövningen gick inte att spara. Försök igen.");
    expect(onSaved).not.toHaveBeenCalled();
    expect(
      (screen.getByRole("radio", { name: "Lämna ut" }) as HTMLInputElement)
        .checked,
    ).toBe(true);
    expect(saveButton().disabled).toBe(false);
  });
});

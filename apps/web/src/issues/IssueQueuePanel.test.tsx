import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import "../i18n";
import type { QueuedIssue } from "../api/issues";
import { IssueQueuePanel } from "./IssueQueuePanel";

/**
 * The triage queue.
 *
 * The case worth having is the protected reporter. This queue is read by an
 * external property manager, and a person with protected personal data
 * (skyddade personuppgifter) is masked in it - the server sends no name, and
 * the panel must not invent one from the identifier it does get.
 */

const setIssueStatus = vi.fn();

vi.mock("../api/issues", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/issues")>()),
  setIssueStatus: (input: unknown) => setIssueStatus(input),
}));

function issue(overrides: Partial<QueuedIssue> = {}): QueuedIssue {
  return {
    id: "issue-1",
    status: "NEW",
    audience: "MEMBER",
    typeId: "type-water",
    typeName: "Vatten",
    location: null,
    description: "Det droppar i taket.",
    apartment: { id: "a-1", number: "1401", address: "Storgatan 12" },
    photos: [],
    reporter: { kind: "resident", personId: "p-1", name: "Rune Boende" },
    createdAt: "2026-08-20T08:00:00.000Z",
    updatedAt: "2026-08-20T08:00:00.000Z",
    ...overrides,
  };
}

beforeEach(() => {
  setIssueStatus.mockReset().mockResolvedValue({ ok: true, value: issue() });
});

describe("who reported it", () => {
  it("names an ordinary reporter", () => {
    render(<IssueQueuePanel issues={[issue()]} onChanged={() => undefined} />);

    expect(screen.getByText("Rune Boende")).toBeTruthy();
  });

  it("withholds the name of a reporter with protected personal data", () => {
    render(
      <IssueQueuePanel
        issues={[issue({ reporter: { kind: "protected", personId: "p-1" } })]}
        onChanged={() => undefined}
      />,
    );

    expect(screen.getByText(/skyddade personuppgifter/i)).toBeTruthy();
    expect(screen.queryByText("Rune Boende")).toBeNull();
  });

  it("says plainly when the register no longer holds the reporter", () => {
    // Issue data is service tier and a person can be purged out from under it.
    // The queue says so rather than breaking or inventing a name.
    render(
      <IssueQueuePanel
        issues={[issue({ reporter: { kind: "unknown" } })]}
        onChanged={() => undefined}
      />,
    );

    expect(screen.getByText(/finns inte längre i registret/i)).toBeTruthy();
  });

  it("shows the contact details a report from the website carried", () => {
    render(
      <IssueQueuePanel
        issues={[
          issue({
            audience: "NON_MEMBER",
            reporter: {
              kind: "external",
              name: "Grannen",
              email: "granne@exempel.se",
            },
          }),
        ]}
        onChanged={() => undefined}
      />,
    );

    expect(screen.getByText(/granne@exempel\.se/)).toBeTruthy();
  });
});

describe("moving a report between the three states", () => {
  it("takes a new one on", async () => {
    const session = userEvent.setup();
    render(<IssueQueuePanel issues={[issue()]} onChanged={() => undefined} />);

    await session.click(
      screen.getByRole("button", { name: /ta hand om det/i }),
    );

    await waitFor(() => {
      expect(setIssueStatus).toHaveBeenCalledWith({
        issueId: "issue-1",
        status: "IN_PROGRESS",
      });
    });
  });

  it("marks one in progress as done", async () => {
    const session = userEvent.setup();
    render(
      <IssueQueuePanel
        issues={[issue({ status: "IN_PROGRESS" })]}
        onChanged={() => undefined}
      />,
    );

    await session.click(
      screen.getByRole("button", { name: /markera som klar/i }),
    );

    await waitFor(() => {
      expect(setIssueStatus).toHaveBeenCalledWith({
        issueId: "issue-1",
        status: "DONE",
      });
    });
  });

  it("reopens one that was closed too early", async () => {
    const session = userEvent.setup();
    render(
      <IssueQueuePanel
        issues={[issue({ status: "DONE" })]}
        onChanged={() => undefined}
      />,
    );

    await session.click(screen.getByRole("button", { name: /öppna igen/i }));

    await waitFor(() => {
      expect(setIssueStatus).toHaveBeenCalledWith({
        issueId: "issue-1",
        status: "NEW",
      });
    });
  });

  it("says so when the change is refused", async () => {
    setIssueStatus.mockResolvedValue({
      ok: false,
      failure: { status: 404, reason: "issue-not-found" },
    });

    const session = userEvent.setup();
    render(<IssueQueuePanel issues={[issue()]} onChanged={() => undefined} />);

    await session.click(
      screen.getByRole("button", { name: /ta hand om det/i }),
    );

    await waitFor(() => {
      expect(screen.getByText(/finns inte längre/i)).toBeTruthy();
    });
  });
});

describe("the state of a report", () => {
  it("carries a word as well as a colour", () => {
    // DESIGN.md: colour is never the only signal.
    render(
      <IssueQueuePanel
        issues={[issue({ status: "IN_PROGRESS" })]}
        onChanged={() => undefined}
      />,
    );

    expect(screen.getByText("Pågår")).toBeTruthy();
  });
});

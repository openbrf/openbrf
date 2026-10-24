import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import "../i18n";
import type { Viewer } from "../api/instance";
import type {
  IssueAudience,
  IssueReporter,
  OwnIssue,
  QueuedIssue,
} from "../api/issues";
import { IssueQueueScreen } from "./IssueQueueScreen";

/**
 * The page the residents' reports are handled from.
 *
 * It is shared by the board and the external property manager, who holds
 * issues:handle and nothing else, so it is signed for both rather than for the
 * board alone - the sign is how a property manager on a phone, with no band in
 * view, is told whose page this is.
 *
 * The API refuses the read whatever the browser was shown, so hiding the queue
 * is courtesy. What is not courtesy is the request: the queue names who
 * reported what from which apartment, and a page that asked for it on a
 * resident's behalf would be asking the server for other people's data with
 * nowhere to put it. So this file asserts the request as well as the panel.
 */

const fetchIssueQueue = vi.fn();
const fetchOwnIssues = vi.fn();
const setIssueStatus = vi.fn();

vi.mock("../api/issues", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/issues")>()),
  fetchIssueQueue: (input?: unknown) => fetchIssueQueue(input),
  fetchOwnIssues: () => fetchOwnIssues(),
  setIssueStatus: (input: unknown) => setIssueStatus(input),
}));

function viewer(capabilities: readonly string[]): Viewer {
  return {
    personId: "person-pia",
    firstName: "Pia",
    lastName: "Förvaltare",
    preferredLocale: "sv",
    capabilities: [...capabilities],
    housingCooperative: null,
  };
}

// The overrides are loose so a test can pair any reporter with any apartment;
// the server only ever sends the pairings `QueuedIssue` allows.
function issue(
  overrides: Partial<OwnIssue> & {
    audience?: IssueAudience;
    reporter?: IssueReporter;
  } = {},
): QueuedIssue {
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
  } as QueuedIssue;
}

/** The external property manager: the queue, and nothing else of the board's. */
const PROPERTY_MANAGER = ["issues:handle", "self:manage"];

beforeEach(() => {
  fetchIssueQueue.mockReset().mockResolvedValue({ ok: true, value: [issue()] });
  fetchOwnIssues.mockReset().mockResolvedValue({ ok: true, value: [] });
  setIssueStatus.mockReset().mockResolvedValue({ ok: true, value: issue() });
});

describe("the property manager", () => {
  it("is given the page under the sign it shares with the board", async () => {
    render(<IssueQueueScreen viewer={viewer(PROPERTY_MANAGER)} />);

    expect(
      await screen.findByRole("heading", {
        level: 1,
        name: "Styrelse och förvaltare Hantera ärenden",
      }),
    ).toBeTruthy();
    expect(
      screen.getByText(
        "Det här ser bara styrelsen, föreningens förvaltare och administratören.",
      ),
    ).toBeTruthy();
  });

  it("is given the queue", async () => {
    render(<IssueQueueScreen viewer={viewer(PROPERTY_MANAGER)} />);

    await waitFor(() => {
      expect(screen.getByText("Ärendekön")).toBeTruthy();
    });
    expect(screen.getByText("Det droppar i taket.")).toBeTruthy();
    expect(screen.getByText("Rune Boende")).toBeTruthy();
    expect(fetchIssueQueue).toHaveBeenCalledTimes(1);
    // A property manager reports nothing here and has no issues of their own
    // to follow; that is the house's page, and not asked for on this one.
    expect(fetchOwnIssues).not.toHaveBeenCalled();
  });
});

describe("a resident", () => {
  it("is told the page is the board's, under no sign, and nothing is read", async () => {
    render(
      <IssueQueueScreen viewer={viewer(["issues:report", "self:manage"])} />,
    );

    expect(
      await screen.findByText(
        "Den här sidan är styrelsens. Ditt konto har inget att göra här.",
      ),
    ).toBeTruthy();
    expect(screen.queryByRole("heading", { level: 1 })).toBeNull();
    expect(screen.queryByText("Styrelse och förvaltare")).toBeNull();
    expect(screen.queryByText("Ärendekön")).toBeNull();
    expect(fetchIssueQueue).not.toHaveBeenCalled();
  });
});

describe("a read that fails", () => {
  it("says so, and does not say nothing has been reported", async () => {
    /*
     * An empty list and a list that failed to arrive are different answers, and
     * the panel has words for only one of them: handed no issues it says nothing
     * has been reported. Said from a request that never answered, that would
     * tell the people who handle the house's faults there are none, and the
     * notice above it would not undo the sentence.
     */
    fetchIssueQueue.mockResolvedValue({
      ok: false,
      failure: { status: 500, reason: "unexpected" },
    });

    render(<IssueQueueScreen viewer={viewer(PROPERTY_MANAGER)} />);

    await waitFor(() => {
      expect(
        screen.getByText("Ärendena kunde inte läsas just nu."),
      ).toBeTruthy();
    });
    expect(screen.queryByText("Ingenting har anmälts.")).toBeNull();
    expect(screen.queryByText("Ärendekön")).toBeNull();
  });
});

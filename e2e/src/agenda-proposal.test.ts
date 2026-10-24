import type { APIRequestContext } from "@playwright/test";
import { describe, expect, it, vi } from "vite-plus/test";

import { proposeAgenda } from "./agenda-proposal";

const BASE = "http://stack.test";
const ITEMS = ["Öppning", "Budget"];

/** The agenda each meeting has, by id. */
const AGENDAS: Record<string, string[]> = {
  earlier: ["earlier-1"],
  fixture: ["fixture-1", "fixture-2"],
  "fixture-b": ["fixture-b-1"],
};

/** A request answering as the API does: meetings by day descending, then id. */
function requestListing(
  meetings: { id: string; heldOn: string }[],
): APIRequestContext {
  const answers: Record<string, unknown> = {
    [`${BASE}/api/meetings`]: meetings,
    [`${BASE}/api/me`]: { personId: "person-1" },
  };
  for (const [id, ids] of Object.entries(AGENDAS)) {
    answers[`${BASE}/api/meetings/${id}`] = {
      agenda: ids.map((itemId) => ({ id: itemId })),
    };
  }
  return {
    get: vi.fn((url: string) =>
      Promise.resolve({
        ok: () => url in answers,
        status: () => (url in answers ? 200 : 404),
        text: () => Promise.resolve(""),
        json: () => Promise.resolve(answers[url]),
      }),
    ),
  } as unknown as APIRequestContext;
}

describe("proposeAgenda", () => {
  it("proposes for the meeting held on the day, not the first in the list", async () => {
    const hold = vi.fn(() => Promise.resolve());
    // An earlier capture's meeting is held later, so the list opens with it.
    const request = requestListing([
      { id: "earlier", heldOn: "2027-01-10" },
      { id: "fixture", heldOn: "2026-11-05" },
    ]);

    await proposeAgenda(
      request,
      BASE,
      { heldOn: "2026-11-05", items: ITEMS },
      hold,
    );

    expect(hold).toHaveBeenCalledExactlyOnceWith({
      actionName: "meeting_set_agenda",
      input: {
        meetingId: "fixture",
        expectedItemIds: ["fixture-1", "fixture-2"],
        items: [{ title: "Öppning" }, { title: "Budget" }],
      },
      proposedByPersonId: "person-1",
    });
  });

  it("takes the first of two meetings held on the day", async () => {
    const hold = vi.fn(() => Promise.resolve());
    const request = requestListing([
      { id: "earlier", heldOn: "2027-01-10" },
      { id: "fixture", heldOn: "2026-11-05" },
      { id: "fixture-b", heldOn: "2026-11-05" },
    ]);

    await proposeAgenda(
      request,
      BASE,
      { heldOn: "2026-11-05", items: ITEMS },
      hold,
    );

    expect(hold).toHaveBeenCalledOnce();
    expect(hold).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({ meetingId: "fixture" }),
      }),
    );
  });

  it("throws and holds nothing when no meeting is held on the day", async () => {
    const hold = vi.fn(() => Promise.resolve());
    const request = requestListing([
      { id: "earlier", heldOn: "2027-01-10" },
      { id: "fixture-b", heldOn: "2026-11-06" },
    ]);

    await expect(
      proposeAgenda(
        request,
        BASE,
        { heldOn: "2026-11-05", items: ITEMS },
        hold,
      ),
    ).rejects.toThrow("no meeting held on 2026-11-05 to propose an agenda for");
    expect(hold).not.toHaveBeenCalled();
  });

  it("throws and holds nothing when there is no meeting at all", async () => {
    const hold = vi.fn(() => Promise.resolve());

    await expect(
      proposeAgenda(
        requestListing([]),
        BASE,
        { heldOn: "2026-11-05", items: ITEMS },
        hold,
      ),
    ).rejects.toThrow("no meeting held on 2026-11-05");
    expect(hold).not.toHaveBeenCalled();
  });
});

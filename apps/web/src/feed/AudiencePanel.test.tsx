import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { AudienceListView } from "@openbrf/shared";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import "../i18n";
import { AudiencePanel, type AudiencePanelProps } from "./AudiencePanel";
import { ALL, BOARD, GARDEN, ok, refused, STAIRWELL } from "./feed-fixtures";

/**
 * The audiences on the side of the feed.
 *
 * **The list is the server's.** Nothing here adds an audience or takes one off;
 * making a group hands its identifier up so the screen reads the list again.
 *
 * **A failure belongs to the panel that owns the act.** Making a group is this
 * panel's act, so its refusal is said here - also when the reader is in no
 * audience yet, which is exactly who the form is for.
 */

const createGroup = vi.fn();
const fetchGroupMembers = vi.fn();
const fetchGroupCandidates = vi.fn();

vi.mock("../api/feed", () => ({
  createGroup: (input: unknown) => createGroup(input),
  fetchGroupMembers: (input: unknown) => fetchGroupMembers(input),
  fetchGroupCandidates: (input: unknown) => fetchGroupCandidates(input),
  addGroupMember: vi.fn(),
  leaveGroup: vi.fn(),
}));

function show(
  list: AudienceListView,
  props: Partial<AudiencePanelProps> = {},
): void {
  render(
    <AudiencePanel
      list={list}
      failure={null}
      selected={null}
      onSelect={() => {}}
      onReload={() => Promise.resolve(true)}
      onCreated={() => {}}
      onLeft={() => {}}
      {...props}
    />,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  fetchGroupMembers.mockResolvedValue(ok([]));
  fetchGroupCandidates.mockResolvedValue(ok([]));
});

describe("the audiences", () => {
  it("are the whole feed, Alla, Styrelsen and each group, with what is unread", () => {
    show({
      audiences: [ALL, { ...BOARD, unread: 2 }, GARDEN],
      mayCreateGroup: true,
    });

    expect(
      screen
        .getAllByRole("button")
        .slice(0, 4)
        .map((button) => button.textContent),
    ).toEqual([
      "Hela flödet",
      "Alla",
      "Styrelsen22 olästa inlägg",
      "Trädgårdsgruppen",
    ]);
  });

  it("opens one when it is pressed, and marks the one open", async () => {
    const onSelect = vi.fn();
    show(
      { audiences: [ALL, GARDEN], mayCreateGroup: true },
      { selected: ALL.id, onSelect },
    );

    expect(
      screen.getByRole("button", { name: "Alla" }).getAttribute("aria-current"),
    ).toBe("true");
    await userEvent.click(
      screen.getByRole("button", { name: "Trädgårdsgruppen" }),
    );

    expect(onSelect).toHaveBeenCalledWith(GARDEN.id);
  });

  it("shows who is in a group only while that group is open", async () => {
    fetchGroupMembers.mockResolvedValue(
      ok([
        {
          person: { kind: "person", personId: "person-bo", name: "Bo Ek" },
          joinedAt: "2026-09-01T09:00:00.000Z",
          createdTheGroup: true,
        },
      ]),
    );
    show(
      { audiences: [ALL, GARDEN, STAIRWELL], mayCreateGroup: true },
      { selected: GARDEN.id },
    );

    expect(await screen.findByText("Bo Ek")).toBeTruthy();
    expect(fetchGroupMembers).toHaveBeenCalledWith({ audienceId: GARDEN.id });
  });

  it("asks nothing about a group when Alla is open", () => {
    show(
      { audiences: [ALL, GARDEN], mayCreateGroup: true },
      { selected: ALL.id },
    );

    expect(fetchGroupMembers).not.toHaveBeenCalled();
    expect(screen.queryByText("Med i gruppen")).toBeNull();
  });
});

describe("making a group", () => {
  it("is offered to somebody who lives here, and hands the new group up", async () => {
    createGroup.mockResolvedValue(
      ok({ audienceId: "audience-new", name: "Uppgång C" }),
    );
    const onCreated = vi.fn();
    show({ audiences: [ALL], mayCreateGroup: true }, { onCreated });

    await userEvent.type(screen.getByLabelText("Starta en grupp"), "Uppgång C");
    await userEvent.click(
      screen.getByRole("button", { name: "Skapa gruppen" }),
    );

    expect(createGroup).toHaveBeenCalledWith({ name: "Uppgång C" });
    await waitFor(() => {
      expect(onCreated).toHaveBeenCalledWith("audience-new");
    });
    expect(
      (screen.getByLabelText("Starta en grupp") as HTMLInputElement).value,
    ).toBe("");
  });

  it("is not offered to an account that lives nowhere", () => {
    show({ audiences: [BOARD], mayCreateGroup: false });

    expect(screen.queryByLabelText("Starta en grupp")).toBeNull();
  });

  it("says a refusal here, also when the reader is in no audience yet", async () => {
    createGroup.mockResolvedValue(refused(422, "not-a-resident"));
    show({ audiences: [], mayCreateGroup: true });

    await userEvent.type(screen.getByLabelText("Starta en grupp"), "Uppgång C");
    await userEvent.click(
      screen.getByRole("button", { name: "Skapa gruppen" }),
    );

    const refusal = await screen.findByText("En grupp är för dem som bor här.");
    expect(refusal.closest("section")?.textContent).toContain(
      "Starta en grupp",
    );
  });

  it("says it is the name that carries a personal identity number", async () => {
    createGroup.mockResolvedValue(refused(422, "personal-identity-number"));
    show({ audiences: [ALL], mayCreateGroup: true });

    await userEvent.type(screen.getByLabelText("Starta en grupp"), "Uppgång C");
    await userEvent.click(
      screen.getByRole("button", { name: "Skapa gruppen" }),
    );

    expect(
      await screen.findByText(/Gruppens namn innehåller ett personnummer/),
    ).toBeTruthy();
  });
});

describe("a list that could not be read again", () => {
  it("stays on screen, with the failure and a retry beside it", async () => {
    const onReload = vi.fn(() => Promise.resolve(true));
    show(
      { audiences: [ALL, GARDEN], mayCreateGroup: true },
      { failure: "failed", onReload },
    );

    expect(
      screen.getByText("Listan över målgrupperna kunde inte läsas om just nu."),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Trädgårdsgruppen" }),
    ).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Försök igen" }));

    expect(onReload).toHaveBeenCalled();
  });

  it("says a refusal is a refusal, with no retry", () => {
    show({ audiences: [ALL], mayCreateGroup: true }, { failure: "notOffered" });

    expect(screen.getByText(/Flödet är för dem som bor i huset/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Försök igen" })).toBeNull();
  });
});

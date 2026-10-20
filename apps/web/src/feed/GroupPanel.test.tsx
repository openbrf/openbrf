import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import "../i18n";
import { ok, refused } from "./feed-fixtures";
import { GroupPanel } from "./GroupPanel";

/**
 * Who is in a group, and the two acts a member has.
 *
 * **Anybody in the group may put a neighbour in, and nobody may take anybody
 * else out.** The one control on a person is leaving, and it is one's own.
 *
 * **The picker is the server's answer.** The panel filters nothing; who may be
 * offered is a question about the register.
 */

const fetchGroupMembers = vi.fn();
const fetchGroupCandidates = vi.fn();
const addGroupMember = vi.fn();
const leaveGroup = vi.fn();

vi.mock("../api/feed", () => ({
  fetchGroupMembers: (input: unknown) => fetchGroupMembers(input),
  fetchGroupCandidates: (input: unknown) => fetchGroupCandidates(input),
  addGroupMember: (input: unknown) => addGroupMember(input),
  leaveGroup: (input: unknown) => leaveGroup(input),
}));

const BO = {
  person: { kind: "person" as const, personId: "person-bo", name: "Bo Ek" },
  joinedAt: "2026-09-01T09:00:00.000Z",
  createdTheGroup: true,
};

beforeEach(() => {
  vi.clearAllMocks();
  fetchGroupMembers.mockResolvedValue(ok([BO]));
  fetchGroupCandidates.mockResolvedValue(
    ok([{ personId: "person-cia", name: "Cia Nord", apartment: "1101" }]),
  );
});

describe("a group's panel", () => {
  it("lists who is in it, and who started it", async () => {
    fetchGroupMembers.mockResolvedValue(
      ok([
        BO,
        {
          person: { kind: "protected", personId: "person-hidden" },
          joinedAt: "2026-09-02T09:00:00.000Z",
          createdTheGroup: false,
        },
      ]),
    );
    render(<GroupPanel audienceId="audience-garden" onLeft={() => {}} />);

    expect(await screen.findByText("Bo Ek")).toBeTruthy();
    expect(screen.getByText("Startade gruppen")).toBeTruthy();
    expect(
      screen.getByText("Skyddade personuppgifter: namnges inte här."),
    ).toBeTruthy();
  });

  it("puts a neighbour in, and shows who is in it afterwards", async () => {
    addGroupMember.mockResolvedValue(
      ok([
        BO,
        {
          person: { kind: "person", personId: "person-cia", name: "Cia Nord" },
          joinedAt: "2026-09-18T09:00:00.000Z",
          createdTheGroup: false,
        },
      ]),
    );
    render(<GroupPanel audienceId="audience-garden" onLeft={() => {}} />);

    await screen.findByRole("option", { name: "Cia Nord, lägenhet 1101" });
    await userEvent.selectOptions(
      screen.getByLabelText("Lägg till någon"),
      "person-cia",
    );
    await userEvent.click(screen.getByRole("button", { name: "Lägg till" }));

    expect(addGroupMember).toHaveBeenCalledWith({
      audienceId: "audience-garden",
      personId: "person-cia",
    });
    expect(await screen.findByText("Cia Nord")).toBeTruthy();
  });

  it("searches the neighbours by what is typed", async () => {
    render(<GroupPanel audienceId="audience-garden" onLeft={() => {}} />);

    await userEvent.type(screen.getByLabelText("Sök bland grannarna"), "Cia");

    await waitFor(() => {
      expect(fetchGroupCandidates).toHaveBeenLastCalledWith({
        audienceId: "audience-garden",
        search: "Cia",
      });
    });
  });

  it("lets the reader leave, and says so to the screen", async () => {
    leaveGroup.mockResolvedValue(ok(undefined));
    const onLeft = vi.fn();
    render(<GroupPanel audienceId="audience-garden" onLeft={onLeft} />);

    await userEvent.click(
      await screen.findByRole("button", { name: "Lämna gruppen" }),
    );

    expect(leaveGroup).toHaveBeenCalledWith({ audienceId: "audience-garden" });
    await waitFor(() => {
      expect(onLeft).toHaveBeenCalled();
    });
  });

  it("offers no control that takes anybody else out", async () => {
    render(<GroupPanel audienceId="audience-garden" onLeft={() => {}} />);
    await screen.findByText("Bo Ek");

    expect(screen.queryByRole("button", { name: /ta bort|Bo Ek/i })).toBeNull();
  });

  it("says out loud when who is in it cannot be read", async () => {
    fetchGroupMembers.mockResolvedValue(refused(404, "audience-not-found"));
    render(<GroupPanel audienceId="audience-garden" onLeft={() => {}} />);

    expect(await screen.findByText(/Den målgruppen finns inte/)).toBeTruthy();
    expect(screen.queryByText("Läser vilka som är med...")).toBeNull();
  });
});

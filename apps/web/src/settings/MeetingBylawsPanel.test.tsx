import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import "../i18n";
import type { MeetingBylaws } from "../api/meetings";
import { MeetingBylawsPanel } from "./MeetingBylawsPanel";

/**
 * Recording what the association's own bylaws say about the general meeting.
 *
 * That the panel opens at the statutory position rather than at a blank. Every
 * one of these four clauses has a rule that applies unless the bylaws displace
 * it, so an association that has recorded nothing is under the statute rather
 * than half-configured - and one member per proxy holder is a housing
 * cooperative's own figure, replacing the three the general Act allows. A board
 * transcribing its stadgar should be able to read that off the screen instead of
 * having to know it.
 *
 * That the panel says which two clauses the platform checks and which two it
 * only reports. A switch that looked like an enforcement would be read as one,
 * and a board that stopped applying the assistant rule itself would be applying
 * nothing at all.
 *
 * That all four are sent together. They are transcribed from one paragraph of
 * the stadgar, and saving them one at a time would let an instance sit in a
 * state the bylaws do not describe.
 *
 * That a limit no clause could name is refused in the form rather than sent.
 */

const saveMeetingBylaws = vi.fn();

vi.mock("../api/instance", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/instance")>()),
  saveMeetingBylaws: (input: unknown) => saveMeetingBylaws(input),
}));

const STATUTORY: MeetingBylaws = {
  proxyHolderEligibilityWidened: false,
  maxMembersPerProxyHolder: 1,
  storageOnlyVoteLimited: false,
  assistantEligibilityWidened: false,
};

beforeEach(() => {
  saveMeetingBylaws.mockReset().mockResolvedValue({
    ok: true,
    value: { meetingBylaws: STATUTORY },
  });
});

describe("the meeting clauses in the bylaws", () => {
  it("opens at the statutory position rather than at a blank", () => {
    render(<MeetingBylawsPanel meetingBylaws={STATUTORY} />);

    // One, and not the general Act's three: BRL 9 kap. 14 § 4 replaces it for a
    // housing cooperative.
    expect(
      screen.getByLabelText<HTMLInputElement>(/^Medlemmar per ombud/u).value,
    ).toBe("1");
    expect(
      screen.getByLabelText<HTMLInputElement>(
        /^Stadgarna tillåter någon annan som ombud/u,
      ).checked,
    ).toBe(false);
  });

  it("says which clauses are checked and which are only reported", () => {
    render(<MeetingBylawsPanel meetingBylaws={STATUTORY} />);

    // The two the platform holds the facts for.
    expect(
      screen.getByText(/Enligt lagen f.r bara medlemmens make/u).textContent,
    ).toContain("Prövas när en fullmakt registreras");
    // And the two it does not, each saying who applies them instead.
    expect(screen.getByText(/Ett garage, en lokal/u).textContent).toContain(
      "tillämpas av stämman",
    );
    expect(
      screen.getByText(/Enligt lagen f.r en medlem bara ta med/u).textContent,
    ).toContain("tillämpas av stämman");
  });

  it("sends all four clauses together", async () => {
    const user = userEvent.setup();
    render(<MeetingBylawsPanel meetingBylaws={STATUTORY} />);

    await user.click(
      screen.getByLabelText(/Stadgarna till.ter n.gon annan som ombud/u),
    );
    const limit = screen.getByLabelText(/^Medlemmar per ombud/u);
    await user.clear(limit);
    await user.type(limit, "3");
    await user.click(
      screen.getByLabelText(/Stadgarna till.ter n.gon annan som bitr.de/u),
    );
    await user.click(screen.getByRole("button", { name: "Spara" }));

    await waitFor(() => {
      expect(saveMeetingBylaws).toHaveBeenCalledWith({
        proxyHolderEligibilityWidened: true,
        maxMembersPerProxyHolder: 3,
        storageOnlyVoteLimited: false,
        assistantEligibilityWidened: true,
      });
    });
  });

  it("will not send a limit no clause could name", async () => {
    const user = userEvent.setup();
    render(<MeetingBylawsPanel meetingBylaws={STATUTORY} />);

    /*
     * Zero would refuse every proxy the statute permits, and a setting that
     * refuses what the law grants is worse than no setting at all. Refused in
     * the form so the answer arrives beside the field rather than as a refusal
     * from the API.
     */
    const limit = screen.getByLabelText(/^Medlemmar per ombud/u);
    await user.clear(limit);
    await user.type(limit, "0");

    const save = screen.getByRole("button", { name: "Spara" });
    expect(save.hasAttribute("disabled")).toBe(true);
    await user.click(save);
    expect(saveMeetingBylaws).not.toHaveBeenCalled();
  });

  it("reads a limit in exponent notation as the number it is", async () => {
    const user = userEvent.setup();
    render(<MeetingBylawsPanel meetingBylaws={STATUTORY} />);

    // `Number.parseInt("1e1", 10)` is 1, so a board that typed ten would have
    // stored a limit of one - which is the statutory position and would look
    // like the save having worked.
    const limit = screen.getByLabelText(/^Medlemmar per ombud/u);
    await user.clear(limit);
    await user.type(limit, "1e1");
    await user.click(screen.getByRole("button", { name: "Spara" }));

    await waitFor(() => {
      expect(saveMeetingBylaws).toHaveBeenCalledWith(
        expect.objectContaining({ maxMembersPerProxyHolder: 10 }),
      );
    });
  });

  it("offers no control at all to a board member who may only read it", () => {
    render(<MeetingBylawsPanel meetingBylaws={STATUTORY} editable={false} />);

    // The board answers for its own bylaws and has to see what the instance
    // believes they say; changing what it holds stays with an administrator.
    expect(screen.queryByRole("button", { name: "Spara" })).toBeNull();
    expect(
      screen.getByLabelText<HTMLInputElement>(/^Medlemmar per ombud/u).disabled,
    ).toBe(true);
  });
});

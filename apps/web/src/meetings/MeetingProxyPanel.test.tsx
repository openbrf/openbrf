import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import "../i18n";
import type { Meeting, MeetingBylaws } from "../api/meetings";
import { MeetingProxyPanel } from "./MeetingProxyPanel";
import type { MeetingPeople, MeetingPerson } from "./use-meeting-people";

/**
 * Registering a proxy authorisation, and what the board is told about its own
 * bylaws before it tries.
 *
 * Which authority the server accepts is decided there against the member
 * register and tested there. What this file pins down is the half a screen owns.
 *
 * That the bylaws in force are stated on the panel rather than left to be
 * discovered through a refusal. A board registering an authority at a door needs
 * to know the rule before it is refused, not after - and the two clauses the
 * platform cannot check have to say so, because a board that read the panel as
 * an enforcement would stop applying them itself.
 *
 * That the ground a member's spouse or cohabitant holds one on is offered and
 * attested rather than proved. The platform holds no record of who is anybody's
 * spouse, and inventing one would take a vote away on a guess.
 *
 * That an authority taken back stays on the panel with its date. Nothing here
 * deletes a row, and a board that struck the wrong one has to be able to see
 * that it did.
 */

const registerProxy = vi.fn();
const withdrawProxy = vi.fn();

vi.mock("../api/meetings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/meetings")>()),
  registerProxy: (input: unknown) => registerProxy(input),
  withdrawProxy: (input: unknown) => withdrawProxy(input),
}));

const PEOPLE: readonly MeetingPerson[] = [
  {
    personId: "person-astrid",
    name: "Astrid Lindqvist",
    apartmentNumbers: ["1001"],
    protectedPersonalData: false,
  },
  {
    personId: "person-ombud",
    name: "Olle Ombudsson",
    apartmentNumbers: ["1002"],
    protectedPersonalData: false,
  },
];

const people: MeetingPeople = {
  ready: true,
  failed: false,
  everyone: PEOPLE,
  find: (personId) => PEOPLE.find((p) => p.personId === personId) ?? null,
};

const STATUTORY: MeetingBylaws = {
  proxyHolderEligibilityWidened: false,
  maxMembersPerProxyHolder: 1,
  storageOnlyVoteLimited: false,
  assistantEligibilityWidened: false,
};

function meeting(overrides: Partial<Meeting> = {}): Meeting {
  return {
    id: "meeting-1",
    kind: "ORDINARY",
    heldOn: "2027-05-20",
    concludedAt: null,
    summoned: false,
    agendaItemCount: 0,
    agenda: [],
    attendances: [],
    proxyAuthorisations: [],
    bylaws: STATUTORY,
    votingRegister: {
      lines: [],
      votesTotal: 0,
      votesPresent: 0,
      assistantsPresent: 0,
      presentWithoutMembership: [],
      proxyHoldersWithoutVote: [],
      storageOnlyVoteLimited: false,
    },
    notice: null,
    ...overrides,
  };
}

beforeEach(() => {
  registerProxy.mockReset();
  withdrawProxy.mockReset();
});

describe("proxy authorisations", () => {
  it("states the statutory rule where the bylaws have not displaced it", () => {
    render(
      <MeetingProxyPanel
        meeting={meeting()}
        people={people}
        onChanged={() => undefined}
      />,
    );

    /*
     * One member per proxy holder is the housing cooperative's rule and replaces
     * the general Act's three, so a board reading "1" here is reading its own
     * position rather than a value somebody left at a default.
     */
    const notice = screen.getByText(/Enligt lagen f.r bara medlemmens make/u);
    expect(notice.textContent).toContain("1 medlem");
    // And the clause the platform cannot check says so on the same line.
    expect(notice.textContent).toContain("styrelsens att intyga");
  });

  it("states the widened rule where the bylaws have displaced it", () => {
    render(
      <MeetingProxyPanel
        meeting={meeting({
          bylaws: {
            ...STATUTORY,
            proxyHolderEligibilityWidened: true,
            maxMembersPerProxyHolder: 3,
          },
        })}
        people={people}
        onChanged={() => undefined}
      />,
    );

    const notice = screen.getByText(/Stadgarna till.ter att n.gon annan/u);
    expect(notice.textContent).toContain("3 medlem");
  });

  it("sends the day the member signed it, not the day it is registered", async () => {
    const user = userEvent.setup();
    const onChanged = vi.fn();
    registerProxy.mockResolvedValue({
      ok: true,
      value: {
        id: "proxy-1",
        memberPersonId: "person-astrid",
        proxyHolderPersonId: "person-ombud",
        ground: "MEMBER",
        authorisedOn: "2027-04-01",
        withdrawnAt: null,
        recordedByPersonId: "person-board",
      },
    });

    render(
      <MeetingProxyPanel
        meeting={meeting()}
        people={people}
        onChanged={onChanged}
      />,
    );

    await user.selectOptions(
      screen.getByLabelText("Medlem som ger fullmakten"),
      "person-astrid",
    );
    await user.selectOptions(screen.getByLabelText("Ombud"), "person-ombud");
    await user.type(
      screen.getByLabelText("Dag då medlemmen skrev under"),
      "2027-04-01",
    );
    await user.click(
      screen.getByRole("button", { name: "Registrera fullmakten" }),
    );

    /*
     * EFL 6 kap. 4 § measures the year from the day the member signed, and the
     * server measures it against the meeting day - so this is the date the form
     * has to ask for and send.
     */
    await waitFor(() => {
      expect(registerProxy).toHaveBeenCalledWith({
        id: "meeting-1",
        values: {
          memberPersonId: "person-astrid",
          proxyHolderPersonId: "person-ombud",
          ground: "MEMBER",
          authorisedOn: "2027-04-01",
        },
      });
    });
    expect(onChanged).toHaveBeenCalled();
  });

  it("will not register an authority with no signing date", async () => {
    /*
     * The date is the one field on this panel the statute keys itself to: EFL
     * 6 kap. 4 § runs the year from the day the member signed, and the server
     * measures that year against the meeting day. An empty one posted would ask
     * the server to decide an authority's validity from nothing.
     *
     * Both halves, because the panel guards both: the control will not send, and
     * neither will the handler - pressing Enter inside a field submits the form
     * directly and would otherwise walk straight past a disabled button.
     */
    const user = userEvent.setup();
    render(
      <MeetingProxyPanel
        meeting={meeting()}
        people={people}
        onChanged={() => undefined}
      />,
    );

    await user.selectOptions(
      screen.getByLabelText("Medlem som ger fullmakten"),
      "person-astrid",
    );
    await user.selectOptions(screen.getByLabelText("Ombud"), "person-ombud");

    const register = screen.getByRole("button", {
      name: "Registrera fullmakten",
    });
    expect(register.hasAttribute("disabled")).toBe(true);

    await user.type(screen.getByLabelText("Ombud"), "{Enter}");
    expect(registerProxy).not.toHaveBeenCalled();
  });

  it("reads the meeting again when an authority is refused", async () => {
    const user = userEvent.setup();
    const onChanged = vi.fn();
    registerProxy.mockResolvedValue({
      ok: false,
      failure: { status: 403, reason: "proxy-holder-limit-reached" },
    });

    render(
      <MeetingProxyPanel
        meeting={meeting()}
        people={people}
        onChanged={onChanged}
      />,
    );

    await user.selectOptions(
      screen.getByLabelText("Medlem som ger fullmakten"),
      "person-astrid",
    );
    await user.selectOptions(screen.getByLabelText("Ombud"), "person-ombud");
    await user.type(
      screen.getByLabelText("Dag då medlemmen skrev under"),
      "2027-04-01",
    );
    await user.click(
      screen.getByRole("button", { name: "Registrera fullmakten" }),
    );

    /*
     * A refusal changes what the voting register says as surely as an acceptance
     * does, because the board's next act depends on which authorities the server
     * actually holds. The sentence names the rule rather than the status: this
     * is a 403, and the shared branch would call it a permission problem.
     */
    await screen.findByText(
      /f.retr.der redan s. m.nga medlemmar som stadgarna till.ter/u,
    );
    expect(onChanged).toHaveBeenCalled();
  });

  it("keeps an authority that was taken back, with its state", async () => {
    render(
      <MeetingProxyPanel
        meeting={meeting({
          proxyAuthorisations: [
            {
              id: "proxy-1",
              memberPersonId: "person-astrid",
              proxyHolderPersonId: "person-ombud",
              ground: "MEMBER",
              authorisedOn: "2027-04-01",
              withdrawnAt: "2027-05-01T09:00:00.000Z",
              recordedByPersonId: "person-board",
            },
          ],
        })}
        people={people}
        onChanged={() => undefined}
      />,
    );

    // Still on the panel, said to be taken back, and offering no way to take it
    // back again.
    expect(screen.getByText("Olle Ombudsson")).toBeTruthy();
    expect(screen.getByText("Återkallad.")).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: /^Återkalla fullmakten/ }),
    ).toBeNull();
  });

  it("becomes a record once the meeting has been recorded as held", () => {
    render(
      <MeetingProxyPanel
        meeting={meeting({
          concludedAt: "2027-05-20T19:00:00.000Z",
          proxyAuthorisations: [
            {
              id: "proxy-1",
              memberPersonId: "person-astrid",
              proxyHolderPersonId: "person-ombud",
              ground: "SPOUSE_OR_COHABITANT",
              authorisedOn: "2027-04-01",
              withdrawnAt: null,
              recordedByPersonId: "person-board",
            },
          ],
        })}
        people={people}
        onChanged={() => undefined}
      />,
    );

    expect(
      screen.queryByRole("button", { name: "Registrera fullmakten" }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: /^Återkalla fullmakten/ }),
    ).toBeNull();
    /*
     * The authorities are still readable, because they are the record of who was
     * entitled to act for whom at a meeting that has happened - down to the
     * ground it rested on, which is the part a protokoll is written from.
     */
    const line = screen.getByText(/Make, maka eller sambo/u);
    expect(line.textContent).toContain("Undertecknad");
    /*
     * The day the member signed, read from the machine-readable attribute rather
     * than from the words: the date is rendered localised on the data face, so
     * the text a reader sees is "torsdag 1 april 2027" and the fact under it is
     * what a register has to be right about.
     */
    expect(line.querySelector("time")?.getAttribute("dateTime")).toBe(
      "2027-04-01",
    );
  });
});

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import "../i18n";
import { PersonPanel } from "./PersonPanel";
import {
  type PersonDetail,
  type PublicationConsent,
  RegisterRequestError,
} from "./register-api";

/**
 * Conferring and revoking a role from the person panel.
 *
 * The rules themselves live on the server and are tested there against a real
 * database. What this file pins down is the half only a screen can get wrong:
 * that the controls a viewer is offered follow the capability they hold, that
 * ending a term asks for the date it ended rather than removing the seat, and
 * that the one refusal a board cannot recover from on its own - the last
 * administrator - is said in words rather than as "try again".
 *
 * The capability list is courtesy and never enforcement: the server refuses
 * every call whatever the browser was shown. That is why the assertions here
 * are about what a person reads, not about what is reachable.
 */

const BOARD_POSITIONS = ["boardPosition:manage"];
const SYSTEM_ROLES = ["systemRole:manage"];

const { electToBoardPosition, endBoardTerm, fetchPerson, setSystemRole } =
  vi.hoisted(() => ({
    electToBoardPosition: vi.fn(),
    endBoardTerm: vi.fn(),
    fetchPerson: vi.fn(),
    setSystemRole: vi.fn(),
  }));

/*
 * The real module is spread in and only the requests are replaced, because
 * RegisterRequestError has to be the real class: the panel decides which
 * refusal sentence to show with `instanceof`, and a stubbed constructor would
 * make every refusal read as the generic one.
 */
vi.mock("./register-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./register-api")>()),
  electToBoardPosition,
  endBoardTerm,
  fetchPerson,
  setSystemRole,
}));

function unasked(): PublicationConsent[] {
  return (["PHOTO", "NAME_ON_SITE", "BOARD_ROSTER"] as const).map((scope) => ({
    scope,
    state: "never" as const,
    grantedOn: null,
    withdrawnOn: null,
    note: null,
  }));
}

const PERSON: PersonDetail = {
  personId: "person-elsa",
  firstName: "Elsa",
  lastName: "Nyman",
  postalAddress: {
    state: "visible",
    street: "Storgatan 12",
    postalCode: "11122",
    city: "Stockholm",
  },
  contact: { state: "visible", email: "elsa@exempel.se", phone: null },
  hasPersonalIdentityNumber: false,
  protectedPersonalData: false,
  preferredLocale: "sv",
  isMember: false,
  residencies: [],
  boardPositions: [],
  systemRoles: [],
  account: {
    state: "active",
    twoFactorEnabled: false,
    invitationExpiresAt: null,
  },
  publicationConsents: unasked(),
  legalHold: null,
};

/** Elected, and not yet stood down. */
const ON_THE_BOARD: PersonDetail = {
  ...PERSON,
  boardPositions: [
    {
      boardPositionId: "seat-chair",
      position: "CHAIR",
      electedOn: "2026-04-14",
      endedOn: null,
    },
  ],
};

/** A term that ran out, which the register keeps. */
const FORMER_BOARD: PersonDetail = {
  ...PERSON,
  boardPositions: [
    {
      boardPositionId: "seat-old",
      position: "BOARD_MEMBER",
      electedOn: "2020-04-14",
      endedOn: "2022-04-14",
    },
  ],
};

const AN_ADMINISTRATOR: PersonDetail = { ...PERSON, systemRoles: ["ADMIN"] };

const noop = (): void => {
  /* intentionally empty */
};

function renderPanel(
  person: PersonDetail,
  capabilities: readonly string[] = [],
  onChanged: () => void = noop,
) {
  fetchPerson.mockResolvedValue(person);
  return render(
    <PersonPanel
      personId={person.personId}
      capabilities={capabilities}
      onClose={noop}
      onChanged={onChanged}
    />,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("what a viewer is offered", () => {
  it("offers nothing to a viewer whose capabilities are not known yet", async () => {
    // The empty list is what "the answer has not arrived" looks like, and the
    // panel gains controls when it does rather than showing one it withdraws.
    renderPanel(ON_THE_BOARD);
    await screen.findByText("Elsa Nyman");

    expect(
      screen.queryByRole("button", { name: /Avsluta uppdraget/ }),
    ).toBeNull();
    expect(screen.queryByRole("button", { name: /^Tilldela/ })).toBeNull();
  });

  it("offers the board its own election and not the system roles", async () => {
    /*
     * The decision this feature turns on, as a person reading the screen meets
     * it. A board seat records the board's own election and does not reach the
     * administrator grant - which the server enforces by there being no route,
     * and which the screen must not contradict by offering a button.
     */
    renderPanel(PERSON, BOARD_POSITIONS);
    await screen.findByText("Elsa Nyman");

    expect(
      screen.queryByRole("button", { name: "Anteckna valet" }),
    ).not.toBeNull();
    expect(screen.queryByRole("button", { name: /^Tilldela/ })).toBeNull();
    expect(screen.queryByText(/Administratörsrollen ger alla/)).toBeNull();
  });

  it("offers an administrator both grants", async () => {
    renderPanel(PERSON, SYSTEM_ROLES);
    await screen.findByText("Elsa Nyman");

    expect(
      screen.queryByRole("button", { name: "Tilldela Administratör" }),
    ).not.toBeNull();
    expect(
      screen.queryByRole("button", { name: "Tilldela Förvaltare" }),
    ).not.toBeNull();
  });

  it("says a role is not held rather than leaving the question open", async () => {
    renderPanel(PERSON, SYSTEM_ROLES);
    await screen.findByText("Elsa Nyman");

    expect(screen.getAllByText("Innehas inte")).toHaveLength(2);
  });
});

describe("recording an election", () => {
  it("sends the position and the date the meeting elected them", async () => {
    electToBoardPosition.mockResolvedValue({
      boardPositionId: "seat-new",
      personId: PERSON.personId,
      position: "CHAIR",
      electedOn: "2026-04-14",
      endedOn: null,
    });
    const onChanged = vi.fn();
    renderPanel(PERSON, BOARD_POSITIONS, onChanged);
    await screen.findByText("Elsa Nyman");

    await userEvent.selectOptions(
      screen.getByLabelText("Uppdrag"),
      "Ordförande",
    );
    await userEvent.type(screen.getByLabelText("Vald den"), "2026-04-14");
    await userEvent.click(
      screen.getByRole("button", { name: "Anteckna valet" }),
    );

    await waitFor(() => {
      expect(electToBoardPosition).toHaveBeenCalledWith(
        PERSON.personId,
        "CHAIR",
        "2026-04-14",
      );
    });
    // The board's rows wear a sign for every seat, so this one is a change the
    // list beside the panel shows.
    expect(onChanged).toHaveBeenCalled();
  });

  it("asks for the date rather than sending the election without one", async () => {
    renderPanel(PERSON, BOARD_POSITIONS);
    await screen.findByText("Elsa Nyman");

    await userEvent.click(
      screen.getByRole("button", { name: "Anteckna valet" }),
    );

    expect((await screen.findByRole("alert")).textContent).toBe(
      "Skriv datumet för valet.",
    );
    expect(electToBoardPosition).not.toHaveBeenCalled();
  });

  it("says so when the person already holds the position", async () => {
    electToBoardPosition.mockRejectedValue(
      new RegisterRequestError(409, "position-already-held"),
    );
    renderPanel(ON_THE_BOARD, BOARD_POSITIONS);
    await screen.findByText("Elsa Nyman");

    await userEvent.type(screen.getByLabelText("Vald den"), "2027-04-14");
    await userEvent.click(
      screen.getByRole("button", { name: "Anteckna valet" }),
    );

    expect((await screen.findByRole("alert")).textContent).toMatch(
      /Personen har redan det uppdraget/,
    );
  });
});

describe("ending a term", () => {
  it("asks for the date the term ended before it ends anything", async () => {
    // Two presses: the first opens the date field for one seat, and nothing is
    // sent until the second. A panel that ended a term on one press would be
    // deciding the date for the board.
    renderPanel(ON_THE_BOARD, BOARD_POSITIONS);
    await screen.findByText("Elsa Nyman");

    expect(screen.queryByLabelText("Uppdraget avslutades")).toBeNull();
    await userEvent.click(
      screen.getByRole("button", { name: "Avsluta uppdraget som Ordförande" }),
    );

    expect(screen.queryByLabelText("Uppdraget avslutades")).not.toBeNull();
    expect(endBoardTerm).not.toHaveBeenCalled();
  });

  it("sends the seat and the date, and never a deletion", async () => {
    endBoardTerm.mockResolvedValue({
      boardPositionId: "seat-chair",
      personId: PERSON.personId,
      position: "CHAIR",
      electedOn: "2026-04-14",
      endedOn: "2027-04-14",
    });
    renderPanel(ON_THE_BOARD, BOARD_POSITIONS);
    await screen.findByText("Elsa Nyman");

    await userEvent.click(
      screen.getByRole("button", { name: "Avsluta uppdraget som Ordförande" }),
    );
    await userEvent.type(
      screen.getByLabelText("Uppdraget avslutades"),
      "2027-04-14",
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Avsluta uppdraget" }),
    );

    await waitFor(() => {
      expect(endBoardTerm).toHaveBeenCalledWith("seat-chair", "2027-04-14");
    });
  });

  it("keeps a term that has run out on the panel, with no way to end it again", async () => {
    /*
     * A position of trust is history. Who answered for the association between
     * two dates survives the term, so an ended one is still on the panel - and
     * the control that would end it is not, because there is nothing left to
     * end.
     */
    renderPanel(FORMER_BOARD, BOARD_POSITIONS);
    await screen.findByText("Elsa Nyman");

    expect(screen.queryByText("2020-04-14")).not.toBeNull();
    expect(screen.queryByText("2022-04-14")).not.toBeNull();
    expect(
      screen.queryByRole("button", { name: /Avsluta uppdraget som/ }),
    ).toBeNull();
  });

  it("says the register keeps an ended term", async () => {
    renderPanel(ON_THE_BOARD, BOARD_POSITIONS);
    await screen.findByText("Elsa Nyman");

    expect(
      screen.queryByText(/Ett avslutat uppdrag ligger kvar/),
    ).not.toBeNull();
  });
});

describe("the system roles", () => {
  it("grants a role", async () => {
    setSystemRole.mockResolvedValue({
      personId: PERSON.personId,
      roles: ["PROPERTY_MANAGER"],
    });
    renderPanel(PERSON, SYSTEM_ROLES);
    await screen.findByText("Elsa Nyman");

    await userEvent.click(
      screen.getByRole("button", { name: "Tilldela Förvaltare" }),
    );

    await waitFor(() => {
      expect(setSystemRole).toHaveBeenCalledWith(
        PERSON.personId,
        "PROPERTY_MANAGER",
        true,
      );
    });
  });

  it("offers a revoke for a role that is held", async () => {
    setSystemRole.mockResolvedValue({ personId: PERSON.personId, roles: [] });
    renderPanel(AN_ADMINISTRATOR, SYSTEM_ROLES);
    await screen.findByText("Elsa Nyman");

    await userEvent.click(
      screen.getByRole("button", { name: "Ta bort Administratör" }),
    );

    await waitFor(() => {
      expect(setSystemRole).toHaveBeenCalledWith(
        PERSON.personId,
        "ADMIN",
        false,
      );
    });
  });

  it("says what to do about the last administrator rather than to try again", async () => {
    /*
     * The one refusal a board cannot recover from by repeating itself. "Try
     * again" would be advice that cannot work: the instance is refusing to be
     * shut from the inside, and the way past it is to grant the role to
     * somebody else first. The screen has to say that.
     */
    setSystemRole.mockRejectedValue(
      new RegisterRequestError(409, "last-administrator"),
    );
    renderPanel(AN_ADMINISTRATOR, SYSTEM_ROLES);
    await screen.findByText("Elsa Nyman");

    await userEvent.click(
      screen.getByRole("button", { name: "Ta bort Administratör" }),
    );

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/sista administratör/);
    expect(alert.textContent).toMatch(/Tilldela rollen till någon annan först/);
  });

  it("never shows the API's own words for a refusal it does not know", async () => {
    // The interface is Swedish by default and the API's messages are English.
    // An unrecognised reason falls back to this screen's own sentence.
    setSystemRole.mockRejectedValue(
      new RegisterRequestError(500, "something-nobody-has-heard-of"),
    );
    renderPanel(PERSON, SYSTEM_ROLES);
    await screen.findByText("Elsa Nyman");

    await userEvent.click(
      screen.getByRole("button", { name: "Tilldela Administratör" }),
    );

    expect((await screen.findByRole("alert")).textContent).toBe(
      "Ändringen kunde inte sparas. Försök igen.",
    );
  });

  it("does not report a failed grant as a success", async () => {
    setSystemRole.mockRejectedValue(new RegisterRequestError(403, null));
    renderPanel(PERSON, SYSTEM_ROLES);
    await screen.findByText("Elsa Nyman");

    await userEvent.click(
      screen.getByRole("button", { name: "Tilldela Administratör" }),
    );

    expect((await screen.findByRole("alert")).textContent).toBe(
      "Ditt konto får inte göra det här.",
    );
    // Still offered as a grant: the panel has not moved on as though the role
    // were held now.
    expect(
      screen.queryByRole("button", { name: "Tilldela Administratör" }),
    ).not.toBeNull();
  });
});

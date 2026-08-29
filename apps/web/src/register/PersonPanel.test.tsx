import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import "../i18n";
import { PersonPanel } from "./PersonPanel";
import { type PersonDetail, RegisterRequestError } from "./register-api";

/**
 * The reveal flow.
 *
 * What this pins down is that a masked field stays masked until someone asks,
 * that asking is a deliberate click rather than something a render does, and that
 * the screen says out loud that the reveal is logged. The API itself is stubbed:
 * the masking it enforces has its own tests against a real database, and what
 * matters here is that this panel never shows a value the server did not hand it
 * in answer to a reveal.
 */

const EMAIL = "sara.berg@exempel.se";
const IDENTITY_NUMBER = "19811228-9874";

const { fetchPerson, revealFields, sendInvitation, setProtectedPersonalData } =
  vi.hoisted(() => ({
    fetchPerson: vi.fn(),
    revealFields: vi.fn(),
    sendInvitation: vi.fn(),
    setProtectedPersonalData: vi.fn(),
  }));

/*
 * The real module is spread in and only the requests are replaced, because
 * RegisterRequestError has to be the real class: the panel decides which
 * failure sentence to show with `instanceof`, and a stubbed constructor would
 * make every refusal read as the generic one.
 */
vi.mock("./register-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./register-api")>()),
  fetchPerson,
  revealFields,
  sendInvitation,
  setProtectedPersonalData,
}));

const PROTECTED_PERSON: PersonDetail = {
  personId: "person-sara",
  firstName: "Sara",
  lastName: "Berg",
  postalAddress: { state: "masked", alternativePostalAddress: null },
  contact: { state: "masked", hasEmail: true, hasPhone: false },
  hasPersonalIdentityNumber: true,
  protectedPersonalData: true,
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
};

const PLAIN_PERSON: PersonDetail = {
  ...PROTECTED_PERSON,
  personId: "person-johan",
  firstName: "Johan",
  lastName: "Berg",
  postalAddress: {
    state: "visible",
    street: "Storgatan 12",
    postalCode: "11122",
    city: "Stockholm",
  },
  contact: { state: "visible", email: EMAIL, phone: null },
  protectedPersonalData: false,
};

/*
 * Four account states, on four people. The panel offers a different action for
 * each, and the register keeps everyone it has ever held, so a person who has
 * been invited is not the same person as one who has not.
 */
const UNINVITED: PersonDetail = {
  ...PLAIN_PERSON,
  personId: "person-elsa",
  firstName: "Elsa",
  lastName: "Nyman",
  account: {
    state: "none",
    twoFactorEnabled: false,
    invitationExpiresAt: null,
  },
};

const UNINVITED_WITHOUT_EMAIL: PersonDetail = {
  ...UNINVITED,
  personId: "person-tore",
  firstName: "Tore",
  lastName: "Nyman",
  contact: { state: "visible", email: null, phone: null },
};

const INVITED: PersonDetail = {
  ...UNINVITED,
  personId: "person-gunnar",
  firstName: "Gunnar",
  lastName: "Nyman",
  account: {
    state: "invited",
    twoFactorEnabled: false,
    invitationExpiresAt: "2099-01-15T09:00:00.000Z",
  },
};

const INVITATION_EXPIRED: PersonDetail = {
  ...INVITED,
  personId: "person-hilda",
  firstName: "Hilda",
  lastName: "Nyman",
  account: {
    state: "invited",
    twoFactorEnabled: false,
    invitationExpiresAt: "2020-03-02T09:00:00.000Z",
  },
};

const noop = (): void => {
  /* intentionally empty */
};

function renderPanel(person: PersonDetail) {
  fetchPerson.mockResolvedValue(person);
  return render(
    <PersonPanel personId={person.personId} onClose={noop} onChanged={noop} />,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("a person with protected personal data", () => {
  it("shows no contact value until it is revealed", async () => {
    renderPanel(PROTECTED_PERSON);
    await screen.findByText("Sara Berg");

    expect(screen.queryByText(EMAIL)).toBeNull();
    expect(revealFields).not.toHaveBeenCalled();
  });

  it("says that revealing is logged, before anyone reveals anything", async () => {
    renderPanel(PROTECTED_PERSON);

    expect(
      await screen.findByText(/granskningsloggen med ditt namn/),
    ).not.toBeNull();
  });

  it("reveals a field only on a deliberate click, and shows what came back", async () => {
    revealFields.mockResolvedValue({ email: EMAIL });
    renderPanel(PROTECTED_PERSON);
    await screen.findByText("Sara Berg");

    const buttons = await screen.findAllByRole("button", { name: /^Visa/ });
    const emailButton = buttons.find((button) =>
      button.getAttribute("aria-label")?.includes("E-postadress"),
    );
    expect(emailButton).not.toBeUndefined();

    await userEvent.click(emailButton as HTMLElement);

    await waitFor(() => {
      expect(screen.getByText(EMAIL)).not.toBeNull();
    });
    expect(revealFields).toHaveBeenCalledWith("person-sara", ["email"]);
  });

  it("can hide a revealed value again without a second request", async () => {
    // Hiding is local: the audit log records that the field was seen, and
    // showing it again would be a second act to record. What this protects is
    // the screen, not the log.
    revealFields.mockResolvedValue({ email: EMAIL });
    renderPanel(PROTECTED_PERSON);
    await screen.findByText("Sara Berg");

    const buttons = await screen.findAllByRole("button", { name: /^Visa/ });
    const emailButton = buttons.find((button) =>
      button.getAttribute("aria-label")?.includes("E-postadress"),
    );
    await userEvent.click(emailButton as HTMLElement);
    await waitFor(() => {
      expect(screen.getByText(EMAIL)).not.toBeNull();
    });

    await userEvent.click(screen.getByRole("button", { name: "Dölj igen" }));

    expect(screen.queryByText(EMAIL)).toBeNull();
    expect(revealFields).toHaveBeenCalledTimes(1);
  });

  it("offers no reveal for a field the register does not hold", async () => {
    // hasPhone is false, so there is nothing to reveal and no button to log a
    // reveal of nothing. Asserted on the button rather than on the word:
    // "Saknas" could come from another field, and a reveal button that appeared
    // here would write an audit entry per click for a field the register does
    // not hold.
    renderPanel(PROTECTED_PERSON);
    await screen.findByText("Sara Berg");

    expect(screen.getAllByText("Saknas").length).toBeGreaterThan(0);
    const reveals = screen.getAllByRole("button", { name: /^Visa/ });
    expect(
      reveals.filter((button) =>
        button.getAttribute("aria-label")?.includes("Telefonnummer"),
      ),
    ).toHaveLength(0);
  });

  it("reports a postal address the register does not hold, not a blank value", async () => {
    // The masked payload carries no presence flag for the postal address, so the
    // completed reveal is what settles it. A blank mono value with a "hide"
    // button reads as "the value is here but hidden", which is the one thing
    // this panel must never say, and it leaves the field revealable for good.
    revealFields.mockResolvedValue({
      postalAddress: { street: null, postalCode: null, city: null },
    });
    renderPanel(PROTECTED_PERSON);
    await screen.findByText("Sara Berg");

    // Only the absent phone number reads "Saknas" before the reveal.
    expect(screen.getAllByText("Saknas")).toHaveLength(1);

    const address = screen
      .getAllByRole("button", { name: /^Visa/ })
      .find((button) =>
        button.getAttribute("aria-label")?.includes("Postadress"),
      );
    expect(address).not.toBeUndefined();

    await userEvent.click(address as HTMLElement);

    await waitFor(() => {
      expect(screen.getAllByText("Saknas")).toHaveLength(2);
    });
    // Nothing came back, so there is nothing to hide and nothing to ask for
    // again.
    expect(screen.queryByRole("button", { name: "Dölj igen" })).toBeNull();
    expect(
      screen
        .getAllByRole("button", { name: /^Visa/ })
        .filter((button) =>
          button.getAttribute("aria-label")?.includes("Postadress"),
        ),
    ).toHaveLength(0);
    expect(revealFields).toHaveBeenCalledTimes(1);
  });

  it("says so when the masking could not be changed", async () => {
    // The call site does not await, so an unreported rejection would leave the
    // button clicked and nothing said - and a board member reading that as
    // success would leave the person unmasked everywhere.
    setProtectedPersonalData.mockRejectedValue(new Error("network"));
    renderPanel(PROTECTED_PERSON);
    await screen.findByText("Sara Berg");

    await userEvent.click(
      screen.getByRole("button", { name: /Sluta maskera den här personen/ }),
    );

    expect(await screen.findByRole("alert")).not.toBeNull();
    expect(
      await screen.findByText("Maskeringen kunde inte ändras. Försök igen."),
    ).not.toBeNull();
  });

  it("masks the postal address, which is what protection exists for", async () => {
    renderPanel(PROTECTED_PERSON);
    await screen.findByText("Sara Berg");

    expect(screen.queryByText(/Storgatan 12/)).toBeNull();
    expect(
      screen.getByText("Ingen alternativ adress registrerad"),
    ).not.toBeNull();
  });
});

describe("a person who is not protected", () => {
  it("shows contact data without a reveal", async () => {
    renderPanel(PLAIN_PERSON);

    expect(await screen.findByText(EMAIL)).not.toBeNull();
  });

  it("still masks the personal identity number", async () => {
    // Always masked, protected flag or not: the audited reveal is the only route
    // to one, and it never appears in a list.
    revealFields.mockResolvedValue({
      personalIdentityNumber: IDENTITY_NUMBER,
    });
    renderPanel(PLAIN_PERSON);
    await screen.findByText("Johan Berg");

    expect(screen.queryByText(IDENTITY_NUMBER)).toBeNull();

    const buttons = screen.getAllByRole("button", { name: /^Visa/ });
    const identityButton = buttons.find((button) =>
      button.getAttribute("aria-label")?.includes("Personnummer"),
    );
    await userEvent.click(identityButton as HTMLElement);

    await waitFor(() => {
      expect(screen.getByText(IDENTITY_NUMBER)).not.toBeNull();
    });
    expect(revealFields).toHaveBeenCalledWith("person-johan", [
      "personalIdentityNumber",
    ]);
  });

  it("offers to start masking the person, and says what that does", async () => {
    setProtectedPersonalData.mockResolvedValue({
      protectedPersonalData: true,
    });
    renderPanel(PLAIN_PERSON);
    await screen.findByText("Johan Berg");

    await userEvent.click(
      screen.getByRole("button", { name: /Maskera den här personen/ }),
    );

    expect(setProtectedPersonalData).toHaveBeenCalledWith("person-johan", true);
  });
});

/**
 * Inviting from the person view.
 *
 * This is the board's half of the way in: an account is created by the person
 * themselves, from a link the board sends here. What the panel has to get right
 * is which state it is in - nobody invited yet, an invitation outstanding, one
 * that has run out, an account that already exists - because the action and the
 * wording differ for each, and a board member cannot see any of it from the
 * rows.
 */
describe("inviting a person to activate an account", () => {
  it("offers an invitation for a person the register has an address for", async () => {
    renderPanel(UNINVITED);
    await screen.findByText("Elsa Nyman");

    expect(
      screen.getByRole("button", { name: "Skicka inbjudan" }),
    ).not.toBeNull();
  });

  it("sends the invitation and reads the person back afterwards", async () => {
    // The refetch is what turns the button into "send again" and puts the new
    // expiry date on screen. Without it the panel would keep offering to invite
    // somebody who has just been invited.
    sendInvitation.mockResolvedValue({ expiresAt: "2099-01-15T09:00:00.000Z" });
    renderPanel(UNINVITED);
    await screen.findByText("Elsa Nyman");

    await userEvent.click(
      screen.getByRole("button", { name: "Skicka inbjudan" }),
    );

    await waitFor(() => {
      expect(
        screen.getByText("Inbjudan är skickad till personens e-postadress."),
      ).not.toBeNull();
    });
    expect(sendInvitation).toHaveBeenCalledWith("person-elsa");
    expect(fetchPerson).toHaveBeenCalledTimes(2);
  });

  it("explains why a person with no address on file cannot be invited", async () => {
    // A button here could only ever fail, and the reason is about the register
    // rather than about the send.
    renderPanel(UNINVITED_WITHOUT_EMAIL);
    await screen.findByText("Tore Nyman");

    expect(
      screen.getByText(
        "Registret har ingen e-postadress för den här personen, så ingen inbjudan kan skickas.",
      ),
    ).not.toBeNull();
    expect(screen.queryByRole("button", { name: /inbjudan/i })).toBeNull();
  });

  it("shows when an outstanding invitation runs out, and offers to send it again", async () => {
    renderPanel(INVITED);
    await screen.findByText("Gunnar Nyman");

    expect(screen.getByText("Inbjudan giltig till 2099-01-15")).not.toBeNull();
    expect(
      screen.getByRole("button", { name: "Skicka inbjudan igen" }),
    ).not.toBeNull();
    expect(screen.queryByText(/har gått ut/)).toBeNull();
  });

  it("says an invitation has expired, and still offers a new one", async () => {
    // Re-sending is offered either way: the API deletes the outstanding
    // invitation and mails a fresh link, so a lost email and an expired one are
    // the same repair.
    sendInvitation.mockResolvedValue({ expiresAt: "2099-01-15T09:00:00.000Z" });
    renderPanel(INVITATION_EXPIRED);
    await screen.findByText("Hilda Nyman");

    expect(
      screen.getByText("Inbjudan har gått ut. Skicka en ny."),
    ).not.toBeNull();

    await userEvent.click(
      screen.getByRole("button", { name: "Skicka inbjudan igen" }),
    );

    expect(sendInvitation).toHaveBeenCalledWith("person-hilda");
  });

  it("names the missing email settings rather than blaming the invitation", async () => {
    // An instance whose setup skipped SMTP answers the send with this, and the
    // fix is in settings: nothing is wrong with the person or the register.
    sendInvitation.mockRejectedValue(
      new RegisterRequestError(503, "mail-not-configured"),
    );
    renderPanel(UNINVITED);
    await screen.findByText("Elsa Nyman");

    await userEvent.click(
      screen.getByRole("button", { name: "Skicka inbjudan" }),
    );

    expect(await screen.findByRole("alert")).not.toBeNull();
    expect(
      await screen.findByText(
        "E-postinställningarna saknas, så inbjudan kunde inte skickas. Fyll i dem under Inställningar.",
      ),
    ).not.toBeNull();
  });

  it("says so when the invitation could not be sent at all", async () => {
    sendInvitation.mockRejectedValue(new Error("network"));
    renderPanel(UNINVITED);
    await screen.findByText("Elsa Nyman");

    await userEvent.click(
      screen.getByRole("button", { name: "Skicka inbjudan" }),
    );

    expect(await screen.findByRole("alert")).not.toBeNull();
    expect(
      await screen.findByText("Inbjudan kunde inte skickas. Försök igen."),
    ).not.toBeNull();
    // Nothing was sent, so nothing is confirmed and the panel is not reloaded.
    expect(fetchPerson).toHaveBeenCalledTimes(1);
  });

  it("offers nothing for a person who already has an account", async () => {
    renderPanel(PLAIN_PERSON);
    await screen.findByText("Johan Berg");

    expect(screen.getByText("Aktivt")).not.toBeNull();
    expect(screen.queryByRole("button", { name: /inbjudan/i })).toBeNull();
  });
});

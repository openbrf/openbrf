import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import "../i18n";
import { PersonPanel } from "./PersonPanel";
import {
  type ConsentScope,
  type PersonDetail,
  type PublicationConsent,
  RegisterRequestError,
} from "./register-api";

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

const {
  fetchDataSubjectReport,
  fetchPerson,
  placeLegalHold,
  releaseLegalHold,
  revealFields,
  sendInvitation,
  setProtectedPersonalData,
  setPublicationConsent,
} = vi.hoisted(() => ({
  fetchDataSubjectReport: vi.fn(),
  fetchPerson: vi.fn(),
  placeLegalHold: vi.fn(),
  releaseLegalHold: vi.fn(),
  revealFields: vi.fn(),
  sendInvitation: vi.fn(),
  setProtectedPersonalData: vi.fn(),
  setPublicationConsent: vi.fn(),
}));

/*
 * The real module is spread in and only the requests are replaced, because
 * RegisterRequestError has to be the real class: the panel decides which
 * failure sentence to show with `instanceof`, and a stubbed constructor would
 * make every refusal read as the generic one.
 */
vi.mock("./register-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./register-api")>()),
  fetchDataSubjectReport,
  fetchPerson,
  placeLegalHold,
  releaseLegalHold,
  revealFields,
  sendInvitation,
  setProtectedPersonalData,
  setPublicationConsent,
}));

/** Every scope, none of them asked about: what a new person carries. */
function unasked(): PublicationConsent[] {
  return (["PHOTO", "NAME_ON_SITE", "BOARD_ROSTER"] as ConsentScope[]).map(
    (scope) => ({
      scope,
      state: "never",
      grantedOn: null,
      withdrawnOn: null,
      note: null,
    }),
  );
}

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
  publicationConsents: unasked(),
  legalHold: null,
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

/**
 * Publication consent, as the board records it.
 *
 * The panel is the board's record of a conversation that happened elsewhere,
 * so what it has to get right is which of three states each scope is in - never
 * asked, agreed, withdrawn - and that a withdrawal keeps the dates it applied
 * between on screen. A failed save must read as a failure: a board member who
 * took one for a success would leave a name publishable after the person asked
 * for it to be taken down.
 */
describe("publication consent", () => {
  const WITH_CONSENTS: PersonDetail = {
    ...PLAIN_PERSON,
    personId: "person-vera",
    firstName: "Vera",
    lastName: "Sund",
    publicationConsents: [
      {
        scope: "PHOTO",
        state: "granted",
        grantedOn: "2026-03-01",
        withdrawnOn: null,
        note: "Sa ja på stämman",
      },
      {
        scope: "NAME_ON_SITE",
        state: "withdrawn",
        grantedOn: "2026-01-10",
        withdrawnOn: "2026-05-05",
        note: null,
      },
      {
        scope: "BOARD_ROSTER",
        state: "never",
        grantedOn: null,
        withdrawnOn: null,
        note: null,
      },
    ],
  };

  it("names every scope, including the ones nobody has asked about", async () => {
    renderPanel(WITH_CONSENTS);
    await screen.findByText("Vera Sund");

    expect(screen.getByText("Fotografier")).not.toBeNull();
    expect(screen.getByText("Namn på webbplatsen")).not.toBeNull();
    expect(screen.getByText("Den publicerade styrelselistan")).not.toBeNull();
    expect(screen.getByText("Inte tillfrågad")).not.toBeNull();
  });

  it("keeps the dates a withdrawn consent applied between", async () => {
    renderPanel(WITH_CONSENTS);
    await screen.findByText("Vera Sund");

    expect(screen.getByText("Samtycke återkallat")).not.toBeNull();
    expect(screen.getByText("2026-01-10")).not.toBeNull();
    expect(screen.getByText("2026-05-05")).not.toBeNull();
  });

  it("shows what the person said when they agreed", async () => {
    renderPanel(WITH_CONSENTS);
    await screen.findByText("Vera Sund");

    expect(screen.getByText("Samtycke lämnat")).not.toBeNull();
    expect(screen.getByText("Sa ja på stämman")).not.toBeNull();
  });

  it("records a consent for the scope that was asked about", async () => {
    setPublicationConsent.mockResolvedValue({
      scope: "BOARD_ROSTER",
      state: "granted",
      grantedOn: "2026-08-29",
      withdrawnOn: null,
      note: null,
    });
    renderPanel(WITH_CONSENTS);
    await screen.findByText("Vera Sund");

    await userEvent.click(
      screen.getByRole("button", {
        name: "Anteckna samtycke för Den publicerade styrelselistan",
      }),
    );

    expect(setPublicationConsent).toHaveBeenCalledWith(
      "person-vera",
      "BOARD_ROSTER",
      true,
    );
    // The refetch is what puts the new date on screen. Without this the panel
    // could drop it and every assertion above would still pass.
    await waitFor(() => {
      expect(fetchPerson).toHaveBeenCalledTimes(2);
    });
  });

  it("offers to withdraw the one that stands, and asks for exactly that", async () => {
    setPublicationConsent.mockResolvedValue({
      scope: "PHOTO",
      state: "withdrawn",
      grantedOn: "2026-03-01",
      withdrawnOn: "2026-08-29",
      note: null,
    });
    renderPanel(WITH_CONSENTS);
    await screen.findByText("Vera Sund");

    await userEvent.click(
      screen.getByRole("button", {
        name: "Återkalla samtycke för Fotografier",
      }),
    );

    expect(setPublicationConsent).toHaveBeenCalledWith(
      "person-vera",
      "PHOTO",
      false,
    );
    await waitFor(() => {
      expect(fetchPerson).toHaveBeenCalledTimes(2);
    });
  });

  it("says so when the consent could not be changed", async () => {
    setPublicationConsent.mockRejectedValue(
      new RegisterRequestError(500, null),
    );
    renderPanel(WITH_CONSENTS);
    await screen.findByText("Vera Sund");

    await userEvent.click(
      screen.getByRole("button", {
        name: "Återkalla samtycke för Fotografier",
      }),
    );

    await waitFor(() => {
      expect(
        screen.getByText("Samtycket kunde inte ändras. Försök igen."),
      ).not.toBeNull();
    });
  });
});

/**
 * The legal hold, and the report it sits beside.
 *
 * A hold is the one thing that stops the purge, so what matters on screen is
 * that a board member can tell whether one stands without reading a date and
 * inferring it, that placing one is refused without a reason before a request
 * is made, and that a failure never reads as a success - somebody who took a
 * failed hold for a successful one would leave a person's data to be erased in
 * the middle of a dispute.
 */

const HELD_PERSON: PersonDetail = {
  ...PLAIN_PERSON,
  personId: "person-siv",
  firstName: "Siv",
  lastName: "Holm",
  legalHold: {
    holdId: "hold-1",
    reason: "Tvist om andrahandsuthyrning",
    placedAt: "2026-08-01T09:00:00.000Z",
    releasedAt: null,
    releaseReason: null,
    placedByPersonId: "person-bo",
    releasedByPersonId: null,
  },
};

describe("the legal hold", () => {
  it("says a person is not held, rather than leaving it to be inferred", async () => {
    renderPanel(PLAIN_PERSON);
    await screen.findByText("Johan Berg");

    expect(screen.getByText(/Inget rättsligt bevarandekrav/)).not.toBeNull();
    expect(
      screen.getByRole("button", {
        name: "Inför ett rättsligt bevarandekrav",
      }),
    ).not.toBeNull();
  });

  it("says out loud that a standing hold stops the purge", async () => {
    // The purge date sits on every ended residency a few lines above. A board
    // member reading that date without this sentence would expect an erasure
    // that is not going to happen.
    renderPanel(HELD_PERSON);
    await screen.findByText("Siv Holm");

    expect(screen.getByText(/gallringen når inte/i)).not.toBeNull();
    expect(screen.getByText("Tvist om andrahandsuthyrning")).not.toBeNull();
    expect(screen.getByText(/Infört 2026-08-01/)).not.toBeNull();
  });

  it("refuses to place a hold with no reason, without asking the server", async () => {
    renderPanel(PLAIN_PERSON);
    await screen.findByText("Johan Berg");

    await userEvent.click(
      screen.getByRole("button", {
        name: "Inför ett rättsligt bevarandekrav",
      }),
    );

    expect(
      screen.getByText("Skriv varför uppgifterna bevaras."),
    ).not.toBeNull();
    expect(placeLegalHold).not.toHaveBeenCalled();
  });

  it("places a hold with the reason that was written, and refetches", async () => {
    placeLegalHold.mockResolvedValue(HELD_PERSON.legalHold);
    renderPanel(PLAIN_PERSON);
    await screen.findByText("Johan Berg");

    await userEvent.type(
      screen.getByLabelText(/Varför uppgifterna bevaras/),
      "Tvist om andrahandsuthyrning",
    );
    await userEvent.click(
      screen.getByRole("button", {
        name: "Inför ett rättsligt bevarandekrav",
      }),
    );

    expect(placeLegalHold).toHaveBeenCalledWith(
      "person-johan",
      "Tvist om andrahandsuthyrning",
    );
    // The refetch is what puts the standing hold on screen. Without it the
    // panel could drop it and every assertion above would still pass.
    await waitFor(() => {
      expect(fetchPerson).toHaveBeenCalledTimes(2);
    });
  });

  it("releases the standing hold, and may be given a reason for lifting it", async () => {
    releaseLegalHold.mockResolvedValue({
      ...HELD_PERSON.legalHold,
      releasedAt: "2026-09-01T09:00:00.000Z",
    });
    renderPanel(HELD_PERSON);
    await screen.findByText("Siv Holm");

    await userEvent.type(
      screen.getByLabelText(/Varför bevarandekravet hävs/),
      "Tvisten avgjord",
    );
    await userEvent.click(
      screen.getByRole("button", {
        name: "Häv det rättsliga bevarandekravet",
      }),
    );

    expect(releaseLegalHold).toHaveBeenCalledWith(
      "person-siv",
      "Tvisten avgjord",
    );
  });

  it("says so when the hold could not be changed", async () => {
    placeLegalHold.mockRejectedValue(
      new RegisterRequestError(409, "already-held"),
    );
    renderPanel(PLAIN_PERSON);
    await screen.findByText("Johan Berg");

    await userEvent.type(
      screen.getByLabelText(/Varför uppgifterna bevaras/),
      "Tvist",
    );
    await userEvent.click(
      screen.getByRole("button", {
        name: "Inför ett rättsligt bevarandekrav",
      }),
    );

    await waitFor(() => {
      expect(
        screen.getByText(
          "Det rättsliga bevarandekravet kunde inte ändras. Försök igen.",
        ),
      ).not.toBeNull();
    });
  });
});

describe("the data subject access report", () => {
  it("is not offered where there is no document view to open it in", async () => {
    // The report replaces the board rather than rendering inside this panel,
    // so a panel with nowhere to send the reader must not offer a button that
    // could only do nothing.
    renderPanel(PLAIN_PERSON);
    await screen.findByText("Johan Berg");

    expect(
      screen.queryByRole("button", { name: "Ta fram registerutdraget" }),
    ).toBeNull();
  });

  it("hands the person on to the document view rather than fetching here", async () => {
    // Producing the report decrypts a personal identity number and writes an
    // audit entry, so this panel never asks for one: it opens the document,
    // which asks once on mount.
    const opened: string[] = [];
    fetchPerson.mockResolvedValue(PLAIN_PERSON);
    render(
      <PersonPanel
        personId={PLAIN_PERSON.personId}
        onClose={noop}
        onChanged={noop}
        onOpenReport={(personId) => opened.push(personId)}
      />,
    );
    await screen.findByText("Johan Berg");

    await userEvent.click(
      screen.getByRole("button", { name: "Ta fram registerutdraget" }),
    );

    expect(opened).toEqual(["person-johan"]);
    expect(fetchDataSubjectReport).not.toHaveBeenCalled();
  });
});

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import "../i18n";
import { PersonPanel } from "./PersonPanel";
import type { PersonDetail } from "./register-api";

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

const { fetchPerson, revealFields, setProtectedPersonalData } = vi.hoisted(
  () => ({
    fetchPerson: vi.fn(),
    revealFields: vi.fn(),
    setProtectedPersonalData: vi.fn(),
  }),
);

vi.mock("./register-api", () => ({
  fetchPerson,
  revealFields,
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

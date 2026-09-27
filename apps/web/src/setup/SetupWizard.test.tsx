import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import "../i18n";
import { ThemeModeProvider } from "../theme/theme-mode-context";
import { AdministratorStep } from "./AdministratorStep";
import { forgetClaim, holdClaim, readHeldClaim } from "./setup-claim";
import { SetupWizard, type SetupWizardProps } from "./SetupWizard";

/**
 * The wizard's sequence rules.
 *
 * Two of them come straight from the plan and are the ones worth guarding:
 * every step after the administrator account and the housing cooperative's name
 * is skippable, and skipping SMTP has a consequence the operator has to be told
 * about, because nobody can be invited to an instance that cannot send mail.
 */

const fetchSettings = vi.fn();
const fetchAddresses = vi.fn();
const completeSetup = vi.fn();
const saveHousingCooperative = vi.fn();
const createFirstAdministrator = vi.fn();
const signInWithPassword = vi.fn();

vi.mock("../api/instance", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/instance")>()),
  fetchSettings: () => fetchSettings(),
  fetchAddresses: () => fetchAddresses(),
  completeSetup: () => completeSetup(),
  saveHousingCooperative: (input: unknown) => saveHousingCooperative(input),
  createFirstAdministrator: (input: unknown) => createFirstAdministrator(input),
}));

vi.mock("../auth/sign-in-methods", () => ({
  signInWithPassword: (...args: unknown[]) => signInWithPassword(...args),
}));

const SETTINGS = {
  housingCooperative: {
    name: "Brf Eksemplet",
    organizationNumber: null,
    defaultLocale: "sv",
    setupCompletedAt: null,
  },
  branding: { primaryColor: null, logo: null, logoDark: null },
  smtp: {
    host: null,
    port: null,
    secure: true,
    user: null,
    fromAddress: null,
    passwordSet: false,
    configured: false,
  },
  retention: { daysAfterMoveOut: 365 },
  selfSignup: { enabled: false },
};

/**
 * Label of the stand-in step, held in a constant so the no-literal-string rule
 * stays strict everywhere including tests.
 */
const CREATE_LABEL = "create";

/**
 * Stands in for the administrator step. It shows the token it was handed, so
 * the wizard's reading of the setup link can be asserted apart from the form.
 */
function administratorStep({
  claimToken,
  onCreated,
}: {
  claimToken: string | null;
  onCreated: () => void;
}): ReactElement {
  return (
    <>
      <button type="button" onClick={onCreated}>
        {CREATE_LABEL}
      </button>
      <output>{claimToken ?? NO_TOKEN}</output>
    </>
  );
}

/** What the stand-in shows when it was handed no token. */
const NO_TOKEN = "no-token";

function renderWizard(
  options: {
    administratorNeeded?: boolean;
    onFinished?: () => void;
    step?: SetupWizardProps["administratorStep"];
  } = {},
) {
  // The appearance step contains the theme toggle, which reads its context.
  return render(
    <ThemeModeProvider>
      <SetupWizard
        administratorNeeded={options.administratorNeeded ?? false}
        onFinished={options.onFinished ?? vi.fn()}
        administratorStep={options.step ?? administratorStep}
      />
    </ThemeModeProvider>,
  );
}

/** Presses the skip button and waits for the next step to arrive. */
async function skip(session: ReturnType<typeof userEvent.setup>) {
  await session.click(screen.getByRole("button", { name: /hoppa över/i }));
}

beforeEach(() => {
  // Every test starts on the wizard's address with no link and nothing held.
  window.history.replaceState(null, "", "/app/setup");
  forgetClaim();
  createFirstAdministrator
    .mockReset()
    .mockResolvedValue({ ok: true, value: { personId: "person-1" } });
  signInWithPassword.mockReset().mockResolvedValue({ status: "signed-in" });
  fetchSettings.mockReset().mockResolvedValue({ ok: true, value: SETTINGS });
  fetchAddresses.mockReset().mockResolvedValue({ ok: true, value: [] });
  completeSetup
    .mockReset()
    .mockResolvedValue({ ok: true, value: { completedAt: "2026-08-27" } });
  saveHousingCooperative
    .mockReset()
    .mockResolvedValue({ ok: true, value: SETTINGS.housingCooperative });
});

describe("the sequence", () => {
  it("starts at the administrator step on first boot", () => {
    renderWizard({ administratorNeeded: true });

    expect(screen.getByRole("button", { name: CREATE_LABEL })).toBeTruthy();
    // Nothing is read before an account exists: both endpoints need a session.
    expect(fetchSettings).not.toHaveBeenCalled();
  });

  it("starts at the housing cooperative when an admin resumes", async () => {
    renderWizard({ administratorNeeded: false });

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: /föreningen/i })).toBeTruthy();
    });
    expect(screen.queryByRole("button", { name: CREATE_LABEL })).toBeNull();
  });

  it("offers no skip on the housing cooperative, which is required", async () => {
    renderWizard();

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: /föreningen/i })).toBeTruthy();
    });
    expect(screen.queryByRole("button", { name: /hoppa över/i })).toBeNull();
  });
});

describe("skipping", () => {
  it("names the skipped steps on the last screen", async () => {
    const session = userEvent.setup();
    renderWizard();

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: /föreningen/i })).toBeTruthy();
    });

    // The name is saved by its own panel; step past it the way the panel does.
    await session.click(screen.getByRole("button", { name: /fortsätt/i }));

    // Addresses, apartments, email, appearance: all four are skippable.
    await skip(session);
    await skip(session);
    await skip(session);
    await skip(session);

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: /är konfigurerad/i }),
      ).toBeTruthy();
    });

    const skippedNotice = screen.getByText(/överhoppat/i);
    expect(skippedNotice.textContent).toContain("Adresser");
    expect(skippedNotice.textContent).toContain("E-post");
  });

  it("warns on the last screen that email is still unconfigured", async () => {
    const session = userEvent.setup();
    renderWizard();

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: /föreningen/i })).toBeTruthy();
    });
    await session.click(screen.getByRole("button", { name: /fortsätt/i }));
    await skip(session);
    await skip(session);
    await skip(session);
    await skip(session);

    // Nobody can be invited to an instance that cannot send mail, so finishing
    // without SMTP has to say so rather than looking complete.
    await waitFor(() => {
      expect(
        screen.getByText(/inbjudningar och inloggningslänkar/i),
      ).toBeTruthy();
    });
  });

  it("does not warn about email once it is configured", async () => {
    fetchSettings.mockResolvedValue({
      ok: true,
      value: {
        ...SETTINGS,
        smtp: {
          ...SETTINGS.smtp,
          host: "smtp.example.se",
          fromAddress: "styrelsen@exempel.se",
          configured: true,
        },
      },
    });

    const session = userEvent.setup();
    renderWizard();

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: /föreningen/i })).toBeTruthy();
    });
    await session.click(screen.getByRole("button", { name: /fortsätt/i }));
    await skip(session);
    await skip(session);
    await skip(session);
    await skip(session);

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: /är konfigurerad/i }),
      ).toBeTruthy();
    });
    expect(screen.queryByText(/e-post är inte inställt/i)).toBeNull();
  });
});

describe("finishing", () => {
  it("tells the caller once the server has stamped it", async () => {
    const onFinished = vi.fn();
    const session = userEvent.setup();
    renderWizard({ onFinished });

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: /föreningen/i })).toBeTruthy();
    });
    await session.click(screen.getByRole("button", { name: /fortsätt/i }));
    await skip(session);
    await skip(session);
    await skip(session);
    await skip(session);
    await session.click(screen.getByRole("button", { name: /^slutför$/i }));

    await waitFor(() => {
      expect(onFinished).toHaveBeenCalledTimes(1);
    });
  });

  it("stays put and says so when the server refuses", async () => {
    // Leaving the screen would tell the operator setup is done when it is not.
    completeSetup.mockResolvedValue({
      ok: false,
      failure: { status: 409, reason: "housing-cooperative-missing" },
    });
    const onFinished = vi.fn();
    const session = userEvent.setup();
    renderWizard({ onFinished });

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: /föreningen/i })).toBeTruthy();
    });
    await session.click(screen.getByRole("button", { name: /fortsätt/i }));
    await skip(session);
    await skip(session);
    await skip(session);
    await skip(session);
    await session.click(screen.getByRole("button", { name: /^slutför$/i }));

    await waitFor(() => {
      expect(screen.getByText(/kunde inte sparas/i)).toBeTruthy();
    });
    expect(onFinished).not.toHaveBeenCalled();
  });
});

/**
 * The setup link (ADR 0023).
 *
 * The token travels in the fragment, which no request carries; the wizard is
 * what reads it, and it must not leave it in the address bar, where it would be
 * bookmarked, shared or read over a shoulder.
 */
describe("the setup link", () => {
  const TOKEN = "Zm9vYmFyLXRoZS10b2tlbi1vbi10aGUtbGluay0wMDE";

  it("reads the token from the fragment and takes it out of the address", async () => {
    window.history.replaceState(null, "", `/app/setup#claim=${TOKEN}`);

    renderWizard({ administratorNeeded: true });

    expect(screen.getByRole("status").textContent).toBe(TOKEN);
    await waitFor(() => {
      expect(window.location.hash).toBe("");
    });
    expect(window.location.pathname).toBe("/app/setup");
    // Held for this tab, so a reload between the link and the form keeps it.
    expect(readHeldClaim()).toBe(TOKEN);
  });

  it("keeps the token across a reload, once the fragment is gone", () => {
    holdClaim(TOKEN);

    renderWizard({ administratorNeeded: true });

    expect(screen.getByRole("status").textContent).toBe(TOKEN);
  });

  it("reads a link opened in a tab that already shows the wizard", async () => {
    // Only the fragment changes, so the browser never loads the wizard again.
    renderWizard({ administratorNeeded: true });
    expect(screen.getByRole("status").textContent).toBe(NO_TOKEN);

    window.location.hash = `claim=${TOKEN}`;

    await waitFor(() => {
      expect(screen.getByRole("status").textContent).toBe(TOKEN);
    });
    await waitFor(() => {
      expect(window.location.hash).toBe("");
    });
  });
});

describe("the administrator step", () => {
  const TOKEN = "Zm9vYmFyLXRoZS10b2tlbi1vbi10aGUtbGluay0wMDI";
  const CODE = "Zm9vYmFyLXRoZS1jb2RlLXR5cGVkLWluLWJ5LWhhbmQ";

  function renderStep() {
    return renderWizard({
      administratorNeeded: true,
      step: (props) => <AdministratorStep {...props} />,
    });
  }

  async function fillIn(session: ReturnType<typeof userEvent.setup>) {
    await session.type(screen.getByLabelText("Förnamn"), "Ingrid");
    await session.type(screen.getByLabelText("Efternamn"), "Forsberg");
    await session.type(
      screen.getByLabelText("E-postadress"),
      "ingrid@exempel.se",
    );
    await session.type(
      screen.getByLabelText(/^Lösenord/),
      "a-long-enough-password",
    );
  }

  it("asks for the setup code when opened without the link, and sends it", async () => {
    const session = userEvent.setup();
    renderStep();

    const field = screen.getByLabelText(/^Installationskod/);
    // The hint says where the link is for somebody who runs the instance.
    expect(field.closest("label")?.textContent).toContain(
      "applikationens logg",
    );
    await session.type(field, CODE);
    await fillIn(session);
    await session.click(screen.getByRole("button", { name: "Skapa kontot" }));

    await waitFor(() => {
      expect(createFirstAdministrator).toHaveBeenCalledTimes(1);
    });
    expect(createFirstAdministrator).toHaveBeenCalledWith(
      expect.objectContaining({ claimToken: CODE }),
    );
  });

  it("sends the link's token and asks for no code", async () => {
    window.history.replaceState(null, "", `/app/setup#claim=${TOKEN}`);
    const session = userEvent.setup();
    renderStep();

    expect(screen.queryByLabelText(/^Installationskod/)).toBeNull();
    expect(screen.getByText("Du använder installationslänken.")).toBeTruthy();

    await fillIn(session);
    await session.click(screen.getByRole("button", { name: "Skapa kontot" }));

    await waitFor(() => {
      expect(createFirstAdministrator).toHaveBeenCalledWith(
        expect.objectContaining({ claimToken: TOKEN }),
      );
    });
    // Claimed, so the token is no longer held anywhere.
    await waitFor(() => {
      expect(readHeldClaim()).toBeNull();
    });
  });

  it("says so in its own sentence when the link or code does not work", async () => {
    createFirstAdministrator.mockResolvedValue({
      ok: false,
      failure: { status: 403, reason: "claim-token-invalid" },
    });
    window.history.replaceState(null, "", `/app/setup#claim=${TOKEN}`);
    const session = userEvent.setup();
    renderStep();

    await fillIn(session);
    await session.click(screen.getByRole("button", { name: "Skapa kontot" }));

    await waitFor(() => {
      expect(
        screen.getByText(/Installationslänken eller koden fungerar inte/),
      ).toBeTruthy();
    });
    // Not read as a weak password, which is what a schema failure shows.
    expect(screen.queryByText(/minst 12 tecken\./)).toBeNull();
    expect(signInWithPassword).not.toHaveBeenCalled();
  });

  it("drops a refused link and asks for the code instead", async () => {
    // A link from before a restart: held in the tab, and dead on the server.
    holdClaim(TOKEN);
    createFirstAdministrator.mockResolvedValueOnce({
      ok: false,
      failure: { status: 403, reason: "claim-token-invalid" },
    });
    const session = userEvent.setup();
    renderStep();

    expect(screen.queryByLabelText(/^Installationskod/)).toBeNull();
    await fillIn(session);
    await session.click(screen.getByRole("button", { name: "Skapa kontot" }));

    // The code field is back, so somebody given only the code can still get in.
    const field = await screen.findByLabelText(/^Installationskod/);
    expect(readHeldClaim()).toBeNull();

    await session.type(field, CODE);
    await session.click(screen.getByRole("button", { name: "Skapa kontot" }));

    await waitFor(() => {
      expect(createFirstAdministrator).toHaveBeenLastCalledWith(
        expect.objectContaining({ claimToken: CODE }),
      );
    });
  });

  it("keeps the code field after a refused code, which was never held", async () => {
    createFirstAdministrator.mockResolvedValue({
      ok: false,
      failure: { status: 403, reason: "claim-token-invalid" },
    });
    const session = userEvent.setup();
    renderStep();

    await session.type(screen.getByLabelText(/^Installationskod/), CODE);
    await fillIn(session);
    await session.click(screen.getByRole("button", { name: "Skapa kontot" }));

    await waitFor(() => {
      expect(
        screen.getByText(/Installationslänken eller koden fungerar inte/),
      ).toBeTruthy();
    });
    // The typed code stays, so it can be corrected rather than typed again.
    expect(
      (screen.getByLabelText(/^Installationskod/) as HTMLInputElement).value,
    ).toBe(CODE);
  });

  it("stops the code at the server's length, so a long paste is not a weak password", () => {
    renderStep();

    expect(
      (screen.getByLabelText(/^Installationskod/) as HTMLInputElement)
        .maxLength,
    ).toBe(200);
  });
});

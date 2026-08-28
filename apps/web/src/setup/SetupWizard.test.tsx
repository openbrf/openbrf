import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import "../i18n";
import { ThemeModeProvider } from "../theme/theme-mode-context";
import { SetupWizard } from "./SetupWizard";

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

vi.mock("../api/instance", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/instance")>()),
  fetchSettings: () => fetchSettings(),
  fetchAddresses: () => fetchAddresses(),
  completeSetup: () => completeSetup(),
  saveHousingCooperative: (input: unknown) => saveHousingCooperative(input),
}));

const SETTINGS = {
  housingCooperative: {
    name: "Brf Eksemplet",
    organizationNumber: null,
    defaultLocale: "sv",
    setupCompletedAt: null,
  },
  branding: { primaryColor: null, logoPath: null },
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

/** Stands in for the administrator step, which has its own test. */
function administratorStep({
  onCreated,
}: {
  onCreated: () => void;
}): ReactElement {
  return (
    <button type="button" onClick={onCreated}>
      {CREATE_LABEL}
    </button>
  );
}

function renderWizard(
  options: { administratorNeeded?: boolean; onFinished?: () => void } = {},
) {
  // The appearance step contains the theme toggle, which reads its context.
  return render(
    <ThemeModeProvider>
      <SetupWizard
        administratorNeeded={options.administratorNeeded ?? false}
        onFinished={options.onFinished ?? vi.fn()}
        administratorStep={administratorStep}
      />
    </ThemeModeProvider>,
  );
}

/** Presses the skip button and waits for the next step to arrive. */
async function skip(session: ReturnType<typeof userEvent.setup>) {
  await session.click(screen.getByRole("button", { name: /hoppa över/i }));
}

beforeEach(() => {
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

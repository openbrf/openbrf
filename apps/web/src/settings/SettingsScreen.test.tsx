import { render, screen, waitFor } from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import "../i18n";
import type { InstanceSettings, Viewer } from "../api/instance";
import { ThemeModeProvider } from "../theme/theme-mode-context";
import { SettingsScreen } from "./SettingsScreen";

/**
 * What each viewer is offered.
 *
 * Hiding a panel is courtesy: the API enforces the same capabilities and
 * refuses the call whatever the interface shows. The reason to test it anyway
 * is that offering a control nobody may use trains a board to ignore refusals,
 * and offering a resident a panel of the instance's SMTP credentials would be a
 * disclosure even before anything was saved.
 */

const fetchSettings = vi.fn();
const fetchAddresses = vi.fn();

vi.mock("../api/instance", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/instance")>()),
  fetchSettings: () => fetchSettings(),
  fetchAddresses: () => fetchAddresses(),
}));

vi.mock("../auth/auth-client", () => ({
  useSession: () => ({ data: { user: { twoFactorEnabled: false } } }),
  authClient: {
    passkey: {
      listUserPasskeys: () => Promise.resolve({ data: [] }),
    },
  },
}));

vi.mock("@tanstack/react-router", () => ({
  Link: ({
    to,
    children,
    className,
  }: {
    to: string;
    children: ReactNode;
    className?: string;
  }): ReactElement => (
    <a href={to} className={className}>
      {children}
    </a>
  ),
}));

// Typed, so a field added, renamed or retyped in the API client breaks this
// fixture instead of leaving the tests passing against a shape the API no
// longer returns.
const SETTINGS: InstanceSettings = {
  housingCooperative: {
    name: "Brf Eksemplet",
    organizationNumber: "769600-1234",
    defaultLocale: "sv",
    setupCompletedAt: "2026-08-27T10:00:00.000Z",
  },
  branding: { primaryColor: null, logoPath: null },
  smtp: {
    host: "smtp.example.se",
    port: 587,
    secure: true,
    user: null,
    fromAddress: "styrelsen@exempel.se",
    passwordSet: true,
    configured: true,
  },
  retention: { daysAfterMoveOut: 365 },
  selfSignup: { enabled: false },
};

function viewerWith(capabilities: string[]): Viewer {
  return {
    personId: "person-1",
    firstName: "Anna",
    lastName: "Andersson",
    preferredLocale: "sv",
    capabilities,
    housingCooperative: {
      name: "Brf Eksemplet",
      primaryColor: null,
      logoPath: null,
    },
  };
}

function renderScreen(capabilities: string[]) {
  return render(
    <ThemeModeProvider>
      <SettingsScreen viewer={viewerWith(capabilities)} />
    </ThemeModeProvider>,
  );
}

const smtpHeading = () => screen.queryByRole("heading", { name: /^e-post$/i });
const profileHeading = () =>
  screen.queryByRole("heading", { name: /din profil/i });

beforeEach(() => {
  fetchSettings.mockReset().mockResolvedValue({ ok: true, value: SETTINGS });
  fetchAddresses.mockReset().mockResolvedValue({ ok: true, value: [] });
});

describe("a resident", () => {
  it("gets their own profile and security, and nothing about the instance", async () => {
    renderScreen(["self:manage", "residentDirectory:read"]);

    await waitFor(() => {
      expect(profileHeading()).toBeTruthy();
    });
    expect(smtpHeading()).toBeNull();
    expect(screen.queryByRole("heading", { name: /gallring/i })).toBeNull();
    // The instance settings are never even asked for.
    expect(fetchSettings).not.toHaveBeenCalled();
  });
});

describe("a board member", () => {
  it("reads the instance settings without being able to change them", async () => {
    renderScreen([
      "association:read",
      "addressBook:read",
      "addressBook:write",
      "self:manage",
    ]);

    await waitFor(() => {
      expect(smtpHeading()).toBeTruthy();
    });
    // Read, not write: the board answers for the retention policy, an admin
    // changes it.
    expect(screen.getByLabelText(/^server$/i)).toHaveProperty("disabled", true);
    expect(screen.getByLabelText(/dagar efter utflyttning/i)).toHaveProperty(
      "disabled",
      true,
    );
  });
});

describe("an admin", () => {
  it("can change the instance settings", async () => {
    renderScreen([
      "association:read",
      "association:manage",
      "addressBook:read",
      "addressBook:write",
      "self:manage",
    ]);

    await waitFor(() => {
      expect(smtpHeading()).toBeTruthy();
    });
    expect(screen.getByLabelText(/^server$/i)).toHaveProperty(
      "disabled",
      false,
    );
  });

  it("is pointed back to the wizard while setup is unfinished", async () => {
    fetchSettings.mockResolvedValue({
      ok: true,
      value: {
        ...SETTINGS,
        housingCooperative: {
          ...SETTINGS.housingCooperative,
          setupCompletedAt: null,
        },
      },
    });

    renderScreen(["association:read", "association:manage", "self:manage"]);

    await waitFor(() => {
      expect(
        screen.getByRole("link", { name: /återuppta konfigurationen/i }),
      ).toBeTruthy();
    });
  });

  it("is not pointed back once setup is finished", async () => {
    renderScreen(["association:read", "association:manage", "self:manage"]);

    await waitFor(() => {
      expect(smtpHeading()).toBeTruthy();
    });
    expect(
      screen.queryByRole("link", { name: /återuppta konfigurationen/i }),
    ).toBeNull();
  });
});

describe("before the reads settle", () => {
  it("offers no editable instance panels", async () => {
    /*
     * The initial value is an empty instance, and the panels built from it are
     * editable. A manager typing a name into an apparently unnamed cooperative
     * would overwrite the stored one - the write upserts - and an apparently
     * empty address list invites a second row for an entrance already in the
     * register, which splits that entrance's apartment numbers across two
     * address rows.
     */
    let release: (() => void) | undefined;
    fetchSettings.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => {
            resolve({ ok: true, value: SETTINGS });
          };
        }),
    );

    renderScreen([
      "association:read",
      "association:manage",
      "addressBook:read",
      "addressBook:write",
      "self:manage",
    ]);

    expect(screen.getByRole("status").textContent).toContain(
      "Hämtar inställningar",
    );
    // The three panels built from the unsettled read. The profile and security
    // panels below them do not depend on it and stay.
    expect(screen.queryByRole("heading", { name: /^föreningen$/i })).toBeNull();
    expect(screen.queryByRole("heading", { name: /^adresser$/i })).toBeNull();
    expect(screen.queryByRole("heading", { name: /^lägenheter$/i })).toBeNull();

    release?.();

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: /^föreningen$/i }),
      ).toBeTruthy();
    });
  });
});

describe("a failed load", () => {
  it("says so when the addresses cannot be read", async () => {
    /*
     * The apartment register hangs off address rows. Rendered as "no addresses
     * registered", a failed load invites a board to add an entrance that already
     * exists, and the apartment numbers for one entrance then split across two
     * address rows - so the failure has to be named rather than shown as an
     * empty register.
     */
    fetchAddresses.mockResolvedValue({
      ok: false,
      failure: { status: 500, reason: "unexpected" },
    });

    renderScreen([
      "association:read",
      "association:manage",
      "addressBook:read",
      "addressBook:write",
      "self:manage",
    ]);

    await waitFor(() => {
      expect(screen.getByText(/kunde inte hämtas/i)).toBeTruthy();
    });
  });
});

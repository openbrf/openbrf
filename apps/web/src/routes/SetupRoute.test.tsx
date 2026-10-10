import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import "../i18n";
import { forgetClaim, readHeldClaim } from "../setup/setup-claim";
import { SetupRoute } from "./SetupRoute";

/**
 * Who may reach the setup wizard.
 *
 * This is the security test of the stage. A first-boot wizard that stays open
 * is an account-creation hole on an instance holding a statutory register, so
 * the screen has exactly two ways in and no third: an unclaimed instance, or a
 * signed-in admin resuming an unfinished setup.
 *
 * The server decides the same question from the database, so these assertions
 * are about not OFFERING a form whose submissions would be refused. That still
 * matters: a wizard that renders its administrator step to a visitor on a live
 * instance tells them the hole might be there.
 */

const fetchSetupState = vi.fn();
const fetchViewer = vi.fn();

/*
 * The real module is spread in and only the reads this file cares about are
 * replaced. Enumerating the exports by hand would break the moment a panel
 * started calling one more of them, and the failure would look like a component
 * bug rather than a missing line in a mock.
 */
vi.mock("../api/instance", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/instance")>()),
  fetchSetupState: () => fetchSetupState(),
  fetchViewer: () => fetchViewer(),
  // The wizard's own loads, stubbed: this file is about access, not content.
  fetchSettings: () =>
    Promise.resolve({
      ok: true,
      value: {
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
      },
    }),
  fetchAddresses: () => Promise.resolve({ ok: true, value: [] }),
  createFirstAdministrator: vi.fn(),
}));

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => vi.fn(),
}));

const administratorHeading = () =>
  screen.queryByRole("heading", { name: /administratörskonto/i });

beforeEach(() => {
  fetchSetupState.mockReset();
  fetchViewer.mockReset();
  window.history.replaceState(null, "", "/app/setup");
  forgetClaim();
});

describe("on an unclaimed instance", () => {
  it("serves the wizard, starting at the administrator step", async () => {
    fetchSetupState.mockResolvedValue({
      ok: true,
      value: { setupRequired: true },
    });

    render(<SetupRoute />);

    await waitFor(() => {
      expect(administratorHeading()).toBeTruthy();
    });
    // No session is asked for: there is nobody to be signed in yet.
    expect(fetchViewer).not.toHaveBeenCalled();
  });
});

describe("once the instance is claimed", () => {
  beforeEach(() => {
    fetchSetupState.mockResolvedValue({
      ok: true,
      value: { setupRequired: false },
    });
  });

  it("lets an admin resume, without offering the administrator step", async () => {
    fetchViewer.mockResolvedValue({
      ok: true,
      value: {
        personId: "person-1",
        firstName: "Holger",
        lastName: "Jensen",
        preferredLocale: "sv",
        capabilities: ["association:manage", "association:read"],
        housingCooperative: null,
      },
    });

    render(<SetupRoute />);

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: /föreningen/i })).toBeTruthy();
    });
    // Creating a second administrator from this screen is impossible on the
    // server, so it must not be on offer here either.
    expect(administratorHeading()).toBeNull();
  });

  it("closes the screen for a signed-in resident", async () => {
    fetchViewer.mockResolvedValue({
      ok: true,
      value: {
        personId: "person-2",
        firstName: "Anna",
        lastName: "Andersson",
        preferredLocale: "sv",
        capabilities: ["self:manage", "residentDirectory:read"],
        housingCooperative: null,
      },
    });

    render(<SetupRoute />);

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: /redan klar/i })).toBeTruthy();
    });
    expect(administratorHeading()).toBeNull();
  });

  it("closes the screen for a visitor with no session", async () => {
    fetchViewer.mockResolvedValue({
      ok: false,
      failure: { status: 401, reason: "unexpected" },
    });

    render(<SetupRoute />);

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: /redan klar/i })).toBeTruthy();
    });
    expect(administratorHeading()).toBeNull();
  });
});

describe("when the state cannot be read", () => {
  it("does not open the wizard on a failed request", async () => {
    // Failing closed: a network error must not be read as "this instance is
    // unclaimed, help yourself".
    fetchSetupState.mockResolvedValue({
      ok: false,
      failure: { status: 0, reason: "offline" },
    });
    fetchViewer.mockResolvedValue({
      ok: false,
      failure: { status: 0, reason: "offline" },
    });

    render(<SetupRoute />);

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: /redan klar/i })).toBeTruthy();
    });
    expect(administratorHeading()).toBeNull();
  });
});

/**
 * The setup link's token must leave the address bar whether or not the wizard
 * mounts (ADR 0023): a failed request shows "closed", and a live link left
 * behind it could be bookmarked or copied while the instance is still open.
 */
describe("the setup link", () => {
  const TOKEN = "Zm9vYmFyLXRoZS10b2tlbi1vbi10aGUtbGluay0wMDM";

  it("is taken out of the address even when the state cannot be read", async () => {
    fetchSetupState.mockResolvedValue({
      ok: false,
      failure: { status: 0, reason: "offline" },
    });
    fetchViewer.mockResolvedValue({
      ok: false,
      failure: { status: 0, reason: "offline" },
    });
    window.history.replaceState(null, "", `/app/setup#claim=${TOKEN}`);

    render(<SetupRoute />);

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: /redan klar/i })).toBeTruthy();
    });
    expect(window.location.hash).toBe("");
    // Held for this tab, so a reload once the server answers still has it.
    expect(readHeldClaim()).toBe(TOKEN);
  });

  it("reaches the wizard without session storage", async () => {
    fetchSetupState.mockResolvedValue({
      ok: true,
      value: { setupRequired: true },
    });
    const unusable = vi
      .spyOn(globalThis, "sessionStorage", "get")
      .mockImplementation(() => {
        throw new Error("blocked");
      });
    window.history.replaceState(null, "", `/app/setup#claim=${TOKEN}`);

    try {
      render(<SetupRoute />);

      await waitFor(() => {
        expect(administratorHeading()).toBeTruthy();
      });
      expect(window.location.hash).toBe("");
      // The route handed the token down, so no code is asked for.
      expect(screen.queryByLabelText(/^Installationskod/)).toBeNull();
    } finally {
      unusable.mockRestore();
    }
  });
});

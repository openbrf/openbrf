import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  onTestFinished,
  vi,
} from "vite-plus/test";

import i18n from "../i18n";
import type { Viewer } from "../api/instance";
import { ThemeModeProvider } from "../theme/theme-mode-context";
import { dropFocus } from "./drop-focus";
import { AccountSettingsScreen } from "./AccountSettingsScreen";

/**
 * The person's own settings, which every account has and which hold nothing
 * about the association: that is the board's page /board/settings.
 */

const fetchSettings = vi.fn();
const saveOwnProfile = vi.fn();

vi.mock("../api/instance", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/instance")>()),
  fetchSettings: () => fetchSettings(),
  saveOwnProfile: (input: unknown) => saveOwnProfile(input),
}));

// The connected apps section inside the security panel self-loads. This file
// is about the account's own page, so it answers with no connections rather
// than reaching for the network.
vi.mock("../connected-apps/connections-api", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../connected-apps/connections-api")
  >()),
  fetchMyConnectedApps: () =>
    Promise.resolve({ ok: true, value: { connectedApps: [] } }),
}));

vi.mock("../auth/auth-client", () => ({
  useSession: () => ({ data: { user: { twoFactorEnabled: false } } }),
  authClient: {
    passkey: {
      listUserPasskeys: () => Promise.resolve({ data: [] }),
    },
  },
}));

/*
 * Where the screen sent the reader instead of rendering. A redirect is the
 * router's business; what this file checks is where the screen asked to go.
 */
const redirected = vi.fn();

vi.mock("@tanstack/react-router", () => ({
  Navigate: (props: { to: string; replace?: boolean }): null => {
    redirected(props);
    return null;
  },
}));

function viewerWith(
  capabilities: string[],
  support?: Viewer["support"],
): Viewer {
  return {
    personId: "person-1",
    firstName: "Anna",
    lastName: "Andersson",
    preferredLocale: "sv",
    capabilities,
    housingCooperative: {
      name: "Brf Eksemplet",
      primaryColor: null,
      logoUrl: null,
      logoDarkUrl: null,
    },
    ...(support === undefined ? {} : { support }),
  };
}

function screenFor(capabilities: string[], support?: Viewer["support"]) {
  return (
    <ThemeModeProvider>
      <AccountSettingsScreen viewer={viewerWith(capabilities, support)} />
    </ThemeModeProvider>
  );
}

function renderScreen(capabilities: string[], support?: Viewer["support"]) {
  return render(screenFor(capabilities, support));
}

const RESIDENT = ["self:manage", "residentDirectory:read"];
const ADMIN = [
  "association:read",
  "association:manage",
  "addressBook:read",
  "addressBook:write",
  "self:manage",
];

const profileHeading = () =>
  screen.queryByRole("heading", { name: /din profil/i });

beforeEach(() => {
  fetchSettings.mockReset();
  saveOwnProfile.mockReset();
  redirected.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
  Reflect.deleteProperty(document, "activeElement");
});

describe("the account's own page", () => {
  it.each([
    ["a resident", RESIDENT],
    ["an administrator", ADMIN],
  ])(
    "gives %s their profile and security, and nothing else",
    (_, capabilities) => {
      renderScreen(capabilities);

      expect(
        screen.getByRole("heading", { level: 1, name: "Inställningar" }),
      ).toBeTruthy();
      expect(profileHeading()).toBeTruthy();
      expect(
        screen.getByRole("heading", { level: 2, name: /säkerhet/i }),
      ).toBeTruthy();
      // No section of the association's, no navigation between sections and no
      // sign: those are the board's page.
      expect(screen.queryByRole("navigation")).toBeNull();
      expect(screen.queryByText("Styrelsen")).toBeNull();
      expect(screen.queryByRole("heading", { name: /^e-post$/i })).toBeNull();
      // Each panel reads for itself; the instance settings are never asked for.
      expect(fetchSettings).not.toHaveBeenCalled();
      expect(redirected).not.toHaveBeenCalled();
    },
  );

  it("sends a support session, which has no account, on to the association's settings", () => {
    renderScreen(ADMIN, {
      supporter: "Kim at the host",
      endsAt: "2026-10-20T20:00:00.000Z",
    });

    expect(redirected).toHaveBeenCalledWith(
      expect.objectContaining({ to: "/board/settings", replace: true }),
    );
    expect(profileHeading()).toBeNull();
  });
});

describe("a save on the profile", () => {
  it("keeps the language that was saved on the profile", async () => {
    onTestFinished(async () => {
      await i18n.changeLanguage("sv");
    });
    const user = userEvent.setup();
    saveOwnProfile.mockResolvedValue({
      ok: true,
      value: { preferredLocale: "en" },
    });
    const { rerender } = renderScreen(ADMIN);

    const select = await screen.findByLabelText<HTMLSelectElement>(
      /språk för e-post och utdrag/i,
    );
    expect(select.value).toBe("sv");
    await user.selectOptions(select, "en");
    await user.click(screen.getByRole("button", { name: /^spara$/i }));
    await waitFor(() => {
      expect(saveOwnProfile).toHaveBeenCalledWith({ preferredLocale: "en" });
    });

    // The viewer above the screen still says Swedish: it is read once, and
    // a save does not read it again.
    rerender(screenFor(ADMIN));

    // The interface follows the saved language; find the select by its name.
    const again = await screen.findByRole<HTMLSelectElement>("combobox");
    expect(again.value).toBe("en");
  });

  /*
   * The profile save changes the language, so the save button is renamed
   * (Spara, Save) and every label on the screen with it. The panel is not
   * reloaded or patched like the instance panels, so focus has to be
   * remembered by its own save.
   */
  describe("the profile save button", () => {
    const profileButton = (): HTMLElement => {
      const form = screen.getByRole("combobox").closest("form");
      return within(form as HTMLElement).getByRole<HTMLElement>("button");
    };

    const saveProfile = async (
      change: string | null,
      stored: string,
      moveFocus?: () => HTMLElement,
    ): Promise<{ before: HTMLElement }> => {
      const user = userEvent.setup();
      let answer: (result: unknown) => void = () => undefined;
      saveOwnProfile.mockReturnValue(
        new Promise((resolve) => {
          answer = resolve;
        }),
      );
      renderScreen(ADMIN);
      const select = await screen.findByLabelText<HTMLSelectElement>(
        /språk för e-post och utdrag/i,
      );
      if (change !== null) {
        await user.selectOptions(select, change);
      }
      const before = profileButton();
      await user.click(before);
      await waitFor(() => {
        expect(profileButton().matches(":disabled")).toBe(true);
      });
      dropFocus();
      expect(document.activeElement).toBe(document.body);
      if (moveFocus !== undefined) {
        moveFocus().focus();
      }

      await act(async () => {
        answer({ ok: true, value: { preferredLocale: stored } });
      });
      await waitFor(() => {
        expect(profileButton().matches(":disabled")).toBe(false);
      });
      return { before };
    };

    beforeEach(() => {
      onTestFinished(async () => {
        await i18n.changeLanguage("sv");
      });
    });

    it("keeps focus when the save switches the language", async () => {
      const { before } = await saveProfile("en", "en");

      expect(profileButton().textContent).toBe("Save");
      expect(document.activeElement).toBe(profileButton());
      expect(profileButton()).toBe(before);
    });

    it("keeps focus when nothing was changed", async () => {
      await saveProfile(null, "sv");

      expect(document.activeElement).toBe(profileButton());
    });

    it("keeps focus on a second save that stores the same language", async () => {
      await saveProfile("en", "en");
      expect(document.activeElement).toBe(profileButton());

      const user = userEvent.setup();
      let answer: (result: unknown) => void = () => undefined;
      saveOwnProfile.mockReturnValue(
        new Promise((resolve) => {
          answer = resolve;
        }),
      );
      await user.click(profileButton());
      await waitFor(() => {
        expect(profileButton().matches(":disabled")).toBe(true);
      });
      dropFocus();
      expect(document.activeElement).toBe(document.body);

      await act(async () => {
        answer({ ok: true, value: { preferredLocale: "en" } });
      });
      await waitFor(() => {
        expect(profileButton().matches(":disabled")).toBe(false);
      });
      expect(saveOwnProfile).toHaveBeenCalledTimes(2);
      expect(document.activeElement).toBe(profileButton());
    });

    it("does not pull focus back from where the reader moved it meanwhile", async () => {
      const select = (): HTMLElement => screen.getByRole("combobox");
      await saveProfile("en", "en", select);

      expect(document.activeElement).toBe(select());
    });
  });
});

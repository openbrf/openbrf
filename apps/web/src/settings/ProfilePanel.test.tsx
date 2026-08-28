import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import i18n from "../i18n";
import type { Viewer } from "../api/instance";
import { ThemeModeProvider } from "../theme/theme-mode-context";
import { ProfilePanel } from "./ProfilePanel";

/**
 * The signed-in person's own settings.
 *
 * The preferred locale is not cosmetic: it decides the language of every email
 * this instance sends that person and of the register extracts produced for
 * them. A screen that keeps speaking the old language after saving reads as if
 * the change had not taken, so the interface follows the value that was stored.
 */

const saveOwnProfile = vi.fn();

vi.mock("../api/instance", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/instance")>()),
  saveOwnProfile: (input: unknown) => saveOwnProfile(input),
}));

const VIEWER: Viewer = {
  personId: "person-1",
  firstName: "Anna",
  lastName: "Andersson",
  preferredLocale: "sv",
  capabilities: ["self:manage"],
  housingCooperative: null,
};

beforeEach(async () => {
  saveOwnProfile.mockReset();
  await i18n.changeLanguage("sv");
});

describe("the preferred locale", () => {
  it("is applied to the interface once the save lands", async () => {
    saveOwnProfile.mockResolvedValue({
      ok: true,
      value: { preferredLocale: "en" },
    });

    const session = userEvent.setup();
    render(
      <ThemeModeProvider>
        <ProfilePanel viewer={VIEWER} />
      </ThemeModeProvider>,
    );

    await session.selectOptions(screen.getByLabelText(/språk/i), "en");
    await session.click(screen.getByRole("button", { name: /^spara$/i }));

    await waitFor(() => {
      expect(i18n.language).toBe("en");
    });
  });

  it("leaves the interface alone when the save is refused", async () => {
    saveOwnProfile.mockResolvedValue({
      ok: false,
      failure: { status: 500, reason: "unexpected" },
    });

    const session = userEvent.setup();
    render(
      <ThemeModeProvider>
        <ProfilePanel viewer={VIEWER} />
      </ThemeModeProvider>,
    );

    await session.selectOptions(screen.getByLabelText(/språk/i), "en");
    await session.click(screen.getByRole("button", { name: /^spara$/i }));

    await waitFor(() => {
      expect(screen.getByText(/kunde inte sparas/i)).toBeTruthy();
    });
    expect(i18n.language).toBe("sv");
  });
});

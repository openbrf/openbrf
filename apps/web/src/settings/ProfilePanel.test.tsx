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
const exportOwnData = vi.fn();

vi.mock("../api/instance", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/instance")>()),
  saveOwnProfile: (input: unknown) => saveOwnProfile(input),
  exportOwnData: () => exportOwnData(),
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
  exportOwnData.mockReset();
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

describe("taking your own data with you", () => {
  it("asks the server and hands the browser a file", async () => {
    /*
     * The one resident-facing route in data protection. An export is a copy of
     * what the person already gave, so there is nothing for the board to
     * decide - unlike erasure, objection and restriction.
     */
    const createObjectURL = vi.fn(() => "blob:mine");
    const revokeObjectURL = vi.fn();
    vi.stubGlobal("URL", {
      ...URL,
      createObjectURL,
      revokeObjectURL,
    });
    exportOwnData.mockResolvedValue({
      ok: true,
      value: { about: { right: "GDPR art. 20" } },
    });

    render(
      <ThemeModeProvider>
        <ProfilePanel viewer={VIEWER} />
      </ThemeModeProvider>,
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Hämta mina uppgifter" }),
    );

    expect(exportOwnData).toHaveBeenCalledTimes(1);
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    // Released again: a blob URL held open is a copy of somebody's own data
    // kept alive in the tab for as long as it stays open.
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:mine");

    vi.unstubAllGlobals();
  });

  it("says so when the export could not be prepared", async () => {
    exportOwnData.mockResolvedValue({ ok: false, error: { reason: "failed" } });

    render(
      <ThemeModeProvider>
        <ProfilePanel viewer={VIEWER} />
      </ThemeModeProvider>,
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Hämta mina uppgifter" }),
    );

    expect(
      screen.getByText("Uppgifterna kunde inte hämtas just nu."),
    ).toBeTruthy();
  });
});

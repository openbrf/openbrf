import { PORTTAVLAN_DARK, PORTTAVLAN_LIGHT } from "@openbrf/tokens";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement, ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { CatalogTheme, ThemeRendering, ThemeSummary } from "../api/themes";
import "../i18n";
import { ThemeRuntimeProvider } from "../theme/theme-runtime-context";
import { ThemesScreen } from "./ThemesScreen";

/**
 * The router's Link needs a router context these tests have no use for, so it
 * is replaced with an anchor. What is under test here is the theme screen, not
 * routing.
 */
vi.mock("@tanstack/react-router", () => ({
  Link: ({
    to,
    children,
    className,
  }: {
    to: string;
    search?: Record<string, string>;
    children: ReactNode;
    className?: string;
  }): ReactElement => (
    <a href={to} className={className}>
      {children}
    </a>
  ),
}));

/**
 * The theme screen.
 *
 * Two behaviours here are the point of the whole stage. A refusal has to say
 * WHY in words a board can act on: the install lint answers with rule codes and
 * measured ratios, and a screen that swallowed them would leave somebody
 * guessing why a theme they chose was rejected. And previewing has to apply the
 * theme to this browser without activating it, because that is what makes
 * activating safe to offer at all.
 */

const fetchActiveTheme = vi.fn();
const fetchInstalledThemes = vi.fn();
const fetchThemeCatalog = vi.fn();
const fetchThemePreview = vi.fn();
const installTheme = vi.fn();
const activateTheme = vi.fn();
const uninstallTheme = vi.fn();

vi.mock("../api/themes", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/themes")>()),
  fetchActiveTheme: () => fetchActiveTheme(),
  fetchInstalledThemes: () => fetchInstalledThemes(),
  fetchThemeCatalog: () => fetchThemeCatalog(),
  fetchThemePreview: (id: string) => fetchThemePreview(id),
  installTheme: (id: string) => installTheme(id),
  activateTheme: (id: string | null) => activateTheme(id),
  uninstallTheme: (id: string) => uninstallTheme(id),
}));

const BUILT_IN: ThemeSummary = {
  id: "porttavlan",
  name: "Porttavlan",
  description: null,
  version: null,
  builtIn: true,
  composed: false,
  active: true,
  extendsThemeId: null,
  fonts: [],
  viewVariants: { memberRegister: "table" },
  installedAt: null,
};

const EXAMPLE: ThemeSummary = {
  id: "example-theme",
  name: "Example",
  description: "Inherits the default theme.",
  version: "1.0.0",
  builtIn: false,
  composed: false,
  active: false,
  extendsThemeId: "porttavlan",
  fonts: [{ family: "Spline Sans Mono", license: "OFL-1.1" }],
  viewVariants: { memberRegister: "table" },
  installedAt: "2026-08-01T00:00:00.000Z",
};

const CATALOG_ENTRY: CatalogTheme = {
  id: "example-theme",
  name: "Example",
  description: "Inherits the default theme.",
  version: "1.0.0",
  contract: "^1.0.0",
  installedVersion: null,
};

const RENDERING: ThemeRendering = {
  id: "example-theme",
  name: "Example",
  builtIn: false,
  modes: {
    light: { ...PORTTAVLAN_LIGHT, "accent-trust": "#2F5D50" },
    dark: { ...PORTTAVLAN_DARK, "accent-trust": "#7FBFAA" },
  },
  fontFaces: [],
  viewVariants: { memberRegister: "table" },
  logoUrl: null,
};

function renderScreen() {
  return render(
    <ThemeRuntimeProvider>
      <ThemesScreen />
    </ThemeRuntimeProvider>,
  );
}

beforeEach(() => {
  for (const mock of [
    fetchActiveTheme,
    fetchInstalledThemes,
    fetchThemeCatalog,
    fetchThemePreview,
    installTheme,
    activateTheme,
    uninstallTheme,
  ]) {
    mock.mockReset();
  }

  fetchActiveTheme.mockResolvedValue({
    ok: true,
    value: {
      ...RENDERING,
      id: "porttavlan",
      name: "Porttavlan",
      builtIn: true,
    },
  });
  fetchInstalledThemes.mockResolvedValue({
    ok: true,
    value: [BUILT_IN, EXAMPLE],
  });
  fetchThemeCatalog.mockResolvedValue({ ok: true, value: [CATALOG_ENTRY] });
});

describe("what a board sees before deciding", () => {
  it("names what each theme inherits, brings and selects", async () => {
    renderScreen();

    await waitFor(() => {
      // Once as an installed theme, once as the catalog entry it came from.
      expect(screen.getAllByRole("heading", { name: "Example" })).toHaveLength(
        2,
      );
    });

    // The parent theme, the typeface with its licence, and the layout it picks:
    // all three are things a board is deciding about, not decoration.
    expect(screen.getByText("porttavlan")).toBeTruthy();
    expect(screen.getByText("Spline Sans Mono (OFL-1.1)")).toBeTruthy();
    // Both themes render the register as a table: the built-in one by default,
    // this one by choosing the same variant.
    expect(screen.getAllByText("memberRegister: table")).toHaveLength(2);
  });

  it("marks the active theme in words, not only in colour", async () => {
    renderScreen();

    await waitFor(() => {
      expect(screen.getByText(/^Aktivt$/)).toBeTruthy();
    });
    expect(screen.getByText(/^Inbyggt$/)).toBeTruthy();
  });

  it("says so when the instance has no catalog configured", async () => {
    fetchThemeCatalog.mockResolvedValue({
      ok: false,
      failure: { status: 503, reason: "catalog-not-configured" },
    });

    renderScreen();

    await waitFor(() => {
      expect(
        screen.getByText(/ingen temakatalog är konfigurerad/i),
      ).toBeTruthy();
    });
  });
});

describe("themes composed on this instance", () => {
  /*
   * The edit link is the composer's way in, and it is offered only for a theme
   * this instance authored. A theme that came from a catalog is replaced by the
   * catalog: offering to edit one would invite a change the next update takes
   * away again.
   */
  it("offers an edit only for a theme composed here", async () => {
    fetchInstalledThemes.mockResolvedValue({
      ok: true,
      value: [
        BUILT_IN,
        EXAMPLE,
        { ...EXAMPLE, id: "eget-tema", name: "Eget", composed: true },
      ],
    });

    renderScreen();

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Eget" })).toBeTruthy();
    });

    expect(screen.getAllByRole("link", { name: /^ändra$/i })).toHaveLength(1);
    expect(screen.getByText(/^Eget tema$/)).toBeTruthy();
    // And the way to compose a new one, whatever is installed.
    expect(
      screen.getByRole("link", { name: /sätt ihop ett tema/i }),
    ).toBeTruthy();
  });

  it("says why a catalog theme cannot be edited here", async () => {
    uninstallTheme.mockResolvedValue({
      ok: false,
      failure: { status: 409, reason: "theme-not-composed" },
    });

    const session = userEvent.setup();
    renderScreen();

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /^ta bort$/i })).toBeTruthy();
    });
    await session.click(screen.getByRole("button", { name: /^ta bort$/i }));

    await waitFor(() => {
      expect(screen.getByText(/kom från en katalog/i)).toBeTruthy();
    });
  });
});

describe("installing", () => {
  it("explains a refusal by naming the rule that refused it", async () => {
    installTheme.mockResolvedValue({
      ok: false,
      failure: {
        status: 422,
        reason: "lint-failed",
        detail: [
          {
            rule: "contrast",
            severity: "error",
            detail: {
              mode: "light",
              foreground: "text-register",
              background: "surface-register",
              ratio: 1.1043,
              required: 4.5,
              statutory: true,
            },
          },
        ],
      },
    });

    const session = userEvent.setup();
    renderScreen();

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /installera/i })).toBeTruthy();
    });
    await session.click(screen.getByRole("button", { name: /installera/i }));

    await waitFor(() => {
      expect(screen.getByText(/temat avvisades/i)).toBeTruthy();
    });
    // The measured ratio, the pair, and that this pair is a statutory one.
    expect(
      screen.getByText(/text-register mot surface-register 1\.10:1/i),
    ).toBeTruthy();
    expect(screen.getByText(/lagstadgade registret/i)).toBeTruthy();
  });

  it("reports what the lint let through with a remark", async () => {
    installTheme.mockResolvedValue({
      ok: true,
      value: {
        theme: EXAMPLE,
        warnings: [
          {
            rule: "unknown-token",
            severity: "warning",
            detail: { mode: "light", token: "surface-holographic" },
          },
        ],
      },
    });

    const session = userEvent.setup();
    renderScreen();

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /installera/i })).toBeTruthy();
    });
    await session.click(screen.getByRole("button", { name: /installera/i }));

    await waitFor(() => {
      expect(screen.getByText(/installerades med anmärkningar/i)).toBeTruthy();
    });
    expect(screen.getByText(/surface-holographic/)).toBeTruthy();
  });
});

describe("previewing and activating", () => {
  it("applies a preview to this browser without activating anything", async () => {
    fetchThemePreview.mockResolvedValue({ ok: true, value: RENDERING });

    const session = userEvent.setup();
    renderScreen();

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /^förhandsgranska$/i }),
      ).toBeTruthy();
    });
    await session.click(
      screen.getByRole("button", { name: /^förhandsgranska$/i }),
    );

    await waitFor(() => {
      expect(
        document.getElementById("openbrf-theme-tokens")?.textContent,
      ).toContain("--obrf-accent-trust: #2F5D50;");
    });

    // Nothing was activated: the notice says the preview is this browser's
    // alone, and no activation call was made.
    expect(screen.getByText(/bara din egen webbläsare/i)).toBeTruthy();
    expect(activateTheme).not.toHaveBeenCalled();
  });

  it("activates the theme and re-reads what the instance renders", async () => {
    activateTheme.mockResolvedValue({
      ok: true,
      value: [
        { ...BUILT_IN, active: false },
        { ...EXAMPLE, active: true },
      ],
    });

    const session = userEvent.setup();
    renderScreen();

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /^aktivera$/i })).toBeTruthy();
    });
    await session.click(screen.getByRole("button", { name: /^aktivera$/i }));

    await waitFor(() => {
      expect(activateTheme).toHaveBeenCalledWith("example-theme");
    });
    // Two reads: the one on mount and the one after activating.
    expect(fetchActiveTheme.mock.calls.length).toBeGreaterThan(1);
  });

  it("passes null to return to the built-in theme", async () => {
    fetchInstalledThemes.mockResolvedValue({
      ok: true,
      value: [
        { ...BUILT_IN, active: false },
        { ...EXAMPLE, active: true },
      ],
    });
    activateTheme.mockResolvedValue({ ok: true, value: [BUILT_IN, EXAMPLE] });

    const session = userEvent.setup();
    renderScreen();

    await waitFor(() => {
      expect(
        screen.getAllByRole("button", { name: /^aktivera$/i }).length,
      ).toBe(1);
    });
    await session.click(screen.getByRole("button", { name: /^aktivera$/i }));

    await waitFor(() => {
      expect(activateTheme).toHaveBeenCalledWith(null);
    });
  });

  /*
   * The activation happened on the server either way. What can still fail is
   * reading back what it now renders, and this browser is then a version
   * behind. Going quiet would leave a board member to conclude the activation
   * did not take, and click it again.
   */
  it("says so when it cannot read back what the instance now renders", async () => {
    activateTheme.mockResolvedValue({
      ok: true,
      value: [
        { ...BUILT_IN, active: false },
        { ...EXAMPLE, active: true },
      ],
    });
    fetchActiveTheme
      .mockResolvedValueOnce({
        ok: true,
        value: { ...RENDERING, id: "porttavlan", builtIn: true },
      })
      .mockResolvedValue({
        ok: false,
        failure: { status: 0, reason: "offline" },
      });

    const session = userEvent.setup();
    renderScreen();

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /^aktivera$/i })).toBeTruthy();
    });
    await session.click(screen.getByRole("button", { name: /^aktivera$/i }));

    await waitFor(() => {
      expect(screen.getByText(/kunde inte läsas om/i)).toBeTruthy();
    });
  });

  /*
   * A preview applies the removed theme's stylesheet to this browser, and its
   * notice offers to activate it. Both have to go with the theme.
   */
  it("stops previewing a theme that has just been removed", async () => {
    fetchThemePreview.mockResolvedValue({ ok: true, value: RENDERING });
    uninstallTheme.mockResolvedValue({ ok: true, value: [BUILT_IN] });

    const session = userEvent.setup();
    renderScreen();

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /^förhandsgranska$/i }),
      ).toBeTruthy();
    });
    await session.click(
      screen.getByRole("button", { name: /^förhandsgranska$/i }),
    );

    await waitFor(() => {
      expect(screen.getByText(/bara din egen webbläsare/i)).toBeTruthy();
    });

    fetchInstalledThemes.mockResolvedValue({ ok: true, value: [BUILT_IN] });
    await session.click(screen.getByRole("button", { name: /^ta bort$/i }));

    await waitFor(() => {
      expect(screen.queryByText(/bara din egen webbläsare/i)).toBeNull();
    });
    expect(document.getElementById("openbrf-theme-tokens")).toBeNull();
  });

  it("names the themes that stop one from being removed", async () => {
    uninstallTheme.mockResolvedValue({
      ok: false,
      failure: {
        status: 409,
        reason: "theme-has-dependants",
        detail: [
          {
            rule: "theme-has-dependants",
            severity: "error",
            detail: { themeId: "child-theme" },
          },
        ],
      },
    });

    const session = userEvent.setup();
    renderScreen();

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /^ta bort$/i })).toBeTruthy();
    });
    await session.click(screen.getByRole("button", { name: /^ta bort$/i }));

    await waitFor(() => {
      expect(
        screen.getByText(/ett annat installerat tema ärver från det/i),
      ).toBeTruthy();
    });
    // Which theme blocks it, not only that something does: otherwise a board
    // member has to open every installed theme to find the one that inherits.
    expect(
      screen.getByText(/child-theme ärver från det här temat/i),
    ).toBeTruthy();
  });
});

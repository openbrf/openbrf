import { PORTTAVLAN_DARK, PORTTAVLAN_LIGHT } from "@openbrf/tokens";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement, ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
  ComposeThemeInput,
  ThemeDeclaration,
  ThemeSummary,
} from "../api/themes";
import "../i18n";
import { ThemeRuntimeProvider } from "../theme/theme-runtime-context";
import { ThemeComposerScreen } from "./ThemeComposerScreen";

/**
 * Composing a theme in the browser.
 *
 * Three things here are the point of the screen rather than decoration. What is
 * previewed is applied to this browser alone and is the same overlay the server
 * will build, so a board approves the theme they are about to save. Only the
 * colours actually changed are sent, so a composed theme stays a child of the
 * one it inherits from instead of becoming a copy that stops following it. And
 * the contrast shown while typing is advice: the refusal that matters comes
 * from the server, and it renders through the same findings list an install
 * refusal does.
 */

const fetchActiveTheme = vi.fn();
const fetchInstalledThemes = vi.fn();
const fetchThemePreview = vi.fn();
const fetchThemeSource = vi.fn();
const composeTheme = vi.fn();
const navigate = vi.fn();

vi.mock("../api/themes", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/themes")>()),
  fetchActiveTheme: () => fetchActiveTheme(),
  fetchInstalledThemes: () => fetchInstalledThemes(),
  fetchThemePreview: (id: string) => fetchThemePreview(id),
  fetchThemeSource: (id: string) => fetchThemeSource(id),
  composeTheme: (input: ComposeThemeInput) => composeTheme(input),
}));

/**
 * The router's Link and useNavigate need a router context these tests have no
 * use for. What is under test is the composer, not routing.
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
  useNavigate: () => navigate,
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

const COMPOSED: ThemeDeclaration = {
  id: "husets-farger",
  displayName: "Husets farger",
  description: "Foreningens egna farger.",
  extendsThemeId: "porttavlan",
  version: "1.0.0",
  composed: true,
  modes: { light: { "accent-trust": "#2F5D50" }, dark: {} },
};

function Harness({ show, themeId }: { show: boolean; themeId?: string }) {
  return (
    <ThemeRuntimeProvider>
      {show ? <ThemeComposerScreen themeId={themeId} /> : null}
    </ThemeRuntimeProvider>
  );
}

function tokenField(token: string): HTMLInputElement {
  return screen.getByLabelText(
    new RegExp(`^Eget värde för ${token}$`),
  ) as HTMLInputElement;
}

beforeEach(() => {
  for (const mock of [
    fetchActiveTheme,
    fetchInstalledThemes,
    fetchThemePreview,
    fetchThemeSource,
    composeTheme,
    navigate,
  ]) {
    mock.mockReset();
  }

  fetchActiveTheme.mockResolvedValue({
    ok: true,
    value: {
      id: "porttavlan",
      name: "Porttavlan",
      builtIn: true,
      modes: { light: PORTTAVLAN_LIGHT, dark: PORTTAVLAN_DARK },
      fontFaces: [],
      viewVariants: { memberRegister: "table" },
      logoUrl: null,
    },
  });
  fetchInstalledThemes.mockResolvedValue({ ok: true, value: [BUILT_IN] });
});

describe("what a composer sees before changing anything", () => {
  it("shows what every colour inherits, and holds no value of its own", async () => {
    render(<Harness show />);

    await waitFor(() => {
      expect(screen.getByLabelText(/^Identifierare/)).toBeTruthy();
    });

    const field = tokenField("surface-page");
    // An empty field with the inherited value as its placeholder: the
    // difference between "inherits this" and "is this" is the difference
    // between a child theme and a copy of its parent.
    expect(field.value).toBe("");
    expect(field.placeholder).toBe(PORTTAVLAN_LIGHT["surface-page"]);
    expect(
      screen.getByText(`Ärver ${PORTTAVLAN_LIGHT["surface-page"]}`),
    ).toBeTruthy();
  });

  it("says that the preview is this browser's alone", async () => {
    render(<Harness show />);

    await waitFor(() => {
      expect(screen.getByText(/bara din egen webbläsare/i)).toBeTruthy();
    });
  });

  /*
   * The measurement in the browser runs on values nobody has saved. Saying so
   * is the difference between advice and a promise the screen cannot keep: the
   * install lint on the server is what refuses a theme.
   */
  it("says the contrast shown here is advice and the server decides", async () => {
    render(<Harness show />);

    await waitFor(() => {
      expect(screen.getByText(/det är servern som avgör/i)).toBeTruthy();
    });
    expect(screen.getByText(/alla färgpar når kontrastkravet/i)).toBeTruthy();
  });
});

describe("composing", () => {
  it("applies the draft to this browser as it is typed", async () => {
    const session = userEvent.setup();
    render(<Harness show />);

    await waitFor(() => {
      expect(screen.getByLabelText(/^Identifierare/)).toBeTruthy();
    });

    await session.type(tokenField("accent-trust"), "#2F5D50");

    await waitFor(() => {
      expect(
        document.getElementById("openbrf-theme-tokens")?.textContent,
      ).toContain("--obrf-accent-trust: #2F5D50;");
    });
    // The rest of the theme is the parent's, unchanged.
    expect(
      document.getElementById("openbrf-theme-tokens")?.textContent,
    ).toContain(`--obrf-surface-page: ${PORTTAVLAN_LIGHT["surface-page"]};`);
  });

  /*
   * The register pairs are statutory: an association has to be able to read the
   * register the law requires it to keep. Saying so while the colour is being
   * chosen is what the browser-side measurement is for.
   */
  it("names a statutory pair that falls below the bar while it is typed", async () => {
    const session = userEvent.setup();
    render(<Harness show />);

    await waitFor(() => {
      expect(screen.getByLabelText(/^Identifierare/)).toBeTruthy();
    });

    await session.type(tokenField("text-register"), "#4D4D4D");

    await waitFor(() => {
      expect(screen.getByText(/färgpar som inte når kravet/i)).toBeTruthy();
    });
    // Both grounds the register text is read on, each with its own measurement.
    expect(
      screen.getByText(/text-register mot surface-register 2\.00:1/i),
    ).toBeTruthy();
    expect(
      screen.getByText(/text-register mot surface-register-raised 1\.77:1/i),
    ).toBeTruthy();
    // And that both pairs are ones the statutory register is read on.
    expect(
      screen.getAllByText(/det här färgparet bär det lagstadgade registret/i),
    ).toHaveLength(2);
  });

  it("sends only the colours that were changed, and goes back to the list", async () => {
    composeTheme.mockResolvedValue({
      ok: true,
      value: { theme: { ...BUILT_IN, id: "husets-farger" }, warnings: [] },
    });

    const session = userEvent.setup();
    render(<Harness show />);

    await waitFor(() => {
      expect(screen.getByLabelText(/^Identifierare/)).toBeTruthy();
    });

    await session.type(
      screen.getByLabelText(/^Identifierare/),
      "husets-farger",
    );
    await session.type(screen.getByLabelText(/^Namn/), "Husets farger");
    await session.type(tokenField("accent-trust"), "#2F5D50");
    // Typed and then set back to what it inherits: not a change, and not sent.
    await session.type(
      tokenField("surface-page"),
      PORTTAVLAN_LIGHT["surface-page"],
    );

    await session.click(screen.getByRole("button", { name: /spara temat/i }));

    await waitFor(() => {
      expect(composeTheme).toHaveBeenCalledWith({
        id: "husets-farger",
        displayName: "Husets farger",
        extends: "porttavlan",
        // Normalised as the field was left, so two spellings of one colour
        // cannot be stored as two different values.
        modes: { light: { "accent-trust": "#2f5d50" }, dark: {} },
      });
    });
    expect(navigate).toHaveBeenCalledWith({ to: "/admin/themes" });
  });

  /*
   * The server runs the same lint an install goes through, so a refusal here
   * carries the same findings and is read by the same component.
   */
  it("explains a refusal by naming the rule that refused it", async () => {
    composeTheme.mockResolvedValue({
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
              ratio: 1.9955,
              required: 4.5,
              statutory: true,
            },
          },
        ],
      },
    });

    const session = userEvent.setup();
    render(<Harness show />);

    await waitFor(() => {
      expect(screen.getByLabelText(/^Identifierare/)).toBeTruthy();
    });
    await session.click(screen.getByRole("button", { name: /spara temat/i }));

    await waitFor(() => {
      expect(screen.getByText(/temat avvisades/i)).toBeTruthy();
    });
    expect(
      screen.getByText(/text-register mot surface-register 2\.00:1/i),
    ).toBeTruthy();
  });

  /*
   * The draft goes with the screen. Left applied, it would show a board member
   * a theme nobody saved on every other screen they opened, and the theme
   * screen would offer to activate it.
   */
  it("stops previewing the draft when the screen goes away", async () => {
    const session = userEvent.setup();
    const { rerender } = render(<Harness show />);

    await waitFor(() => {
      expect(screen.getByLabelText(/^Identifierare/)).toBeTruthy();
    });
    await session.type(tokenField("accent-trust"), "#2F5D50");

    await waitFor(() => {
      expect(document.getElementById("openbrf-theme-tokens")).not.toBeNull();
    });

    rerender(<Harness show={false} />);

    await waitFor(() => {
      expect(document.getElementById("openbrf-theme-tokens")).toBeNull();
    });
  });
});

describe("editing a composed theme", () => {
  it("prefills what the theme declares and holds its identifier", async () => {
    fetchThemeSource.mockResolvedValue({ ok: true, value: COMPOSED });

    render(<Harness show themeId="husets-farger" />);

    await waitFor(() => {
      expect(screen.getByLabelText(/^Namn/)).toBeTruthy();
    });

    expect((screen.getByLabelText(/^Namn/) as HTMLInputElement).value).toBe(
      "Husets farger",
    );
    expect(
      (screen.getByLabelText(/^Beskrivning/) as HTMLInputElement).value,
    ).toBe("Foreningens egna farger.");
    expect(tokenField("accent-trust").value).toBe("#2F5D50");
    // Everything else is still inherited rather than copied down.
    expect(tokenField("surface-page").value).toBe("");

    /*
     * The identifier is the theme's identity on disk, in its row and in every
     * other theme's `extends`. Changing it would be a new theme rather than an
     * edit of this one.
     */
    const identifier = screen.getByLabelText(
      /^Identifierare/,
    ) as HTMLInputElement;
    expect(identifier.value).toBe("husets-farger");
    expect(identifier.readOnly).toBe(true);

    expect(fetchThemeSource).toHaveBeenCalledWith("husets-farger");
  });

  it("refuses to edit a theme that came from a catalog", async () => {
    fetchThemeSource.mockResolvedValue({
      ok: true,
      value: { ...COMPOSED, composed: false },
    });

    render(<Harness show themeId="husets-farger" />);

    await waitFor(() => {
      expect(screen.getByText(/kom från en katalog/i)).toBeTruthy();
    });
    expect(screen.queryByLabelText(/^Identifierare/)).toBeNull();
  });
});

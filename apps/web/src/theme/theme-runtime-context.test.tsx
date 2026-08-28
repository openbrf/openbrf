import { PORTTAVLAN_DARK, PORTTAVLAN_LIGHT } from "@openbrf/tokens";
import { render, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ThemeRendering } from "../api/themes";
import {
  ThemeRuntimeProvider,
  useThemeRuntime,
  useViewVariant,
} from "./theme-runtime-context";

/**
 * The view-variant mechanism.
 *
 * A theme may choose among layouts the core maintains; it may not ship one.
 * What a view asks for is therefore always answered with a layout that exists:
 * the theme's choice when the core has it, and the slot's default otherwise -
 * including while the active theme is still being read, which is the case a
 * register view would otherwise render nothing in.
 */

const fetchActiveTheme = vi.fn();

vi.mock("../api/themes", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/themes")>()),
  fetchActiveTheme: () => fetchActiveTheme(),
}));

function renderingWith(viewVariants: Record<string, string>): ThemeRendering {
  return {
    id: "example-theme",
    name: "Example",
    builtIn: false,
    modes: { light: PORTTAVLAN_LIGHT, dark: PORTTAVLAN_DARK },
    fontFaces: [],
    viewVariants,
    logoUrl: null,
  };
}

function Variant(): ReactElement {
  const variant = useViewVariant("memberRegister");
  const unknownSlot = useViewVariant("dashboard");
  return (
    <>
      <span data-testid="member-register">{variant ?? "none"}</span>
      <span data-testid="dashboard">{unknownSlot ?? "none"}</span>
    </>
  );
}

function ActiveName(): ReactElement {
  const { applied } = useThemeRuntime();
  return <span data-testid="applied">{applied?.name ?? "loading"}</span>;
}

beforeEach(() => {
  fetchActiveTheme.mockReset();
});

describe("useViewVariant", () => {
  it("answers with the core default before the active theme has loaded", () => {
    fetchActiveTheme.mockReturnValue(new Promise(() => undefined));

    render(
      <ThemeRuntimeProvider>
        <Variant />
      </ThemeRuntimeProvider>,
    );

    expect(screen.getByTestId("member-register").textContent).toBe("table");
  });

  it("answers with the variant the active theme chose", async () => {
    fetchActiveTheme.mockResolvedValue({
      ok: true,
      value: renderingWith({ memberRegister: "table" }),
    });

    render(
      <ThemeRuntimeProvider>
        <Variant />
        <ActiveName />
      </ThemeRuntimeProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("applied").textContent).toBe("Example");
    });
    expect(screen.getByTestId("member-register").textContent).toBe("table");
  });

  it("falls back rather than returning a layout the core cannot draw", async () => {
    // The install lint refuses an unknown variant, so this should never reach a
    // running instance. A view still has to be able to draw something.
    fetchActiveTheme.mockResolvedValue({
      ok: true,
      value: renderingWith({ memberRegister: "cards" }),
    });

    render(
      <ThemeRuntimeProvider>
        <Variant />
        <ActiveName />
      </ThemeRuntimeProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("applied").textContent).toBe("Example");
    });
    expect(screen.getByTestId("member-register").textContent).toBe("table");
  });

  it("has nothing to say about a slot the core does not have", () => {
    fetchActiveTheme.mockReturnValue(new Promise(() => undefined));

    render(
      <ThemeRuntimeProvider>
        <Variant />
      </ThemeRuntimeProvider>,
    );

    expect(screen.getByTestId("dashboard").textContent).toBe("none");
  });
});

describe("a failed read of the active theme", () => {
  it("leaves the interface on the built-in theme rather than unstyled", async () => {
    fetchActiveTheme.mockResolvedValue({
      ok: false,
      failure: { status: 0, reason: "offline" },
    });

    render(
      <ThemeRuntimeProvider>
        <Variant />
        <ActiveName />
      </ThemeRuntimeProvider>,
    );

    await waitFor(() => {
      expect(document.getElementById("openbrf-theme-tokens")).toBeNull();
    });
    expect(screen.getByTestId("member-register").textContent).toBe("table");
  });
});

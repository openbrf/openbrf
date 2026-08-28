import { PORTTAVLAN_DARK, PORTTAVLAN_LIGHT } from "@openbrf/tokens";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ApiResult } from "../api/client";
import type { ThemeRendering } from "../api/themes";
import {
  ThemeRuntimeProvider,
  useThemeRuntime,
  useViewVariant,
} from "./theme-runtime-context";

/**
 * The view-variant mechanism, and which read decides what is rendered.
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

function renderingNamed(name: string): ThemeRendering {
  return {
    ...renderingWith({ memberRegister: "table" }),
    id: name.toLowerCase(),
    name,
  };
}

function ActiveName(): ReactElement {
  const { applied } = useThemeRuntime();
  return <span data-testid="applied">{applied?.name ?? "loading"}</span>;
}

/** A read of the active theme that answers only when the test says so. */
function pendingRead(): {
  promise: Promise<ApiResult<ThemeRendering>>;
  answer: (rendering: ThemeRendering) => void;
} {
  let settle: ((result: ApiResult<ThemeRendering>) => void) | undefined;
  const promise = new Promise<ApiResult<ThemeRendering>>((resolve) => {
    settle = resolve;
  });
  return {
    promise,
    answer: (rendering) => {
      settle?.({ ok: true, value: rendering });
    },
  };
}

/** Stands in for the theme screen: it shows what is applied, and reloads. */
function Reloader(): ReactElement {
  const { applied, reload } = useThemeRuntime();
  return (
    <>
      <span data-testid="applied">{applied?.name ?? "loading"}</span>
      <button
        type="button"
        data-testid="reload"
        onClick={() => {
          void reload();
        }}
      />
    </>
  );
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

/**
 * Two reads in flight at once.
 *
 * The provider reads the active theme on mount, and the theme screen asks for
 * another read the moment an activation succeeds. Both go to the same endpoint,
 * and nothing makes the answers arrive in the order they were sent.
 */
describe("an older read that answers after a newer one", () => {
  it("does not put back the theme the newer read replaced", async () => {
    const onMount = pendingRead();
    const afterActivation = pendingRead();
    fetchActiveTheme
      .mockReturnValueOnce(onMount.promise)
      .mockReturnValueOnce(afterActivation.promise);

    const session = userEvent.setup();
    render(
      <ThemeRuntimeProvider>
        <Reloader />
      </ThemeRuntimeProvider>,
    );

    // The activation's read starts while the mount read is still open.
    await session.click(screen.getByTestId("reload"));

    await act(async () => {
      afterActivation.answer(renderingNamed("Activated"));
      await afterActivation.promise;
    });
    expect(screen.getByTestId("applied").textContent).toBe("Activated");

    // The mount read finally answers, carrying the theme that was active
    // before the activation.
    await act(async () => {
      onMount.answer(renderingNamed("Previous"));
      await onMount.promise;
    });
    expect(screen.getByTestId("applied").textContent).toBe("Activated");
  });

  it("still tells its own caller that it landed", async () => {
    const onMount = pendingRead();
    const afterActivation = pendingRead();
    fetchActiveTheme
      .mockReturnValueOnce(onMount.promise)
      .mockReturnValueOnce(afterActivation.promise);

    let landed: boolean | undefined;
    function Overtaken(): ReactElement {
      const { reload } = useThemeRuntime();
      return (
        <button
          type="button"
          data-testid="reload"
          onClick={() => {
            void reload().then((result) => {
              landed = result;
            });
          }}
        />
      );
    }

    const session = userEvent.setup();
    render(
      <ThemeRuntimeProvider>
        <Overtaken />
      </ThemeRuntimeProvider>,
    );

    // A third read overtakes the one the button started.
    await session.click(screen.getByTestId("reload"));
    fetchActiveTheme.mockResolvedValue({
      ok: true,
      value: renderingNamed("Newest"),
    });
    await session.click(screen.getByTestId("reload"));

    await act(async () => {
      afterActivation.answer(renderingNamed("Overtaken"));
      await afterActivation.promise;
    });
    expect(landed).toBe(true);

    onMount.answer(renderingNamed("Previous"));
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

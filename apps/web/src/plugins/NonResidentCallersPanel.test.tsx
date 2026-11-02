import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import "../i18n";
import { NonResidentCallersPanel } from "./NonResidentCallersPanel";
import type { PluginSummary } from "./plugin-api";

/**
 * Whom each plugin's resident routes serve besides residents (ADR 0053), and
 * the administrator's withdrawal of one class and consent to it again.
 *
 * Rendered in Swedish, the association's default, so a label that fell back to
 * its key would show here.
 */

const setPluginNonResidentCallerWithdrawn = vi.fn();

vi.mock("./plugin-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./plugin-api")>()),
  setPluginNonResidentCallerWithdrawn: (
    id: string,
    caller: string,
    withdrawn: boolean,
  ) => setPluginNonResidentCallerWithdrawn(id, caller, withdrawn),
}));

// Typed, so a field added to the API client breaks this fixture.
function pluginWith(overrides: Partial<PluginSummary> = {}): PluginSummary {
  return {
    id: "parkering",
    packageName: "@openbrf/plugin-parkering",
    version: "2.0.0",
    enabled: true,
    status: "INSTALLED",
    lastError: null,
    failure: null,
    loaded: true,
    permissions: ["addressBook:read"],
    personalData: ["name"],
    consentedActions: [],
    armedActions: [],
    installedAt: "2026-11-02T09:00:00.000Z",
    hasSettings: false,
    view: null,
    extensionPoints: [],
    extends: [],
    nonResidentCallers: [
      {
        caller: "board",
        withdrawn: false,
        consented: { by: "Anna Admin", at: "2026-11-02T09:00:00.000Z" },
        withdrawnBy: null,
      },
      {
        caller: "propertyManager",
        withdrawn: true,
        consented: { by: "Anna Admin", at: "2026-11-02T09:00:00.000Z" },
        withdrawnBy: { by: null, at: "2026-11-02T10:30:00.000Z" },
      },
    ],
    ...overrides,
  };
}

const onChanged = vi.fn();

function renderPanel(plugins: PluginSummary[], editable = true) {
  return render(
    <NonResidentCallersPanel
      plugins={plugins}
      editable={editable}
      onChanged={onChanged}
    />,
  );
}

beforeEach(() => {
  onChanged.mockReset();
  setPluginNonResidentCallerWithdrawn
    .mockReset()
    .mockResolvedValue({ ok: true, value: undefined });
});

describe("the panel", () => {
  it("is absent when no plugin serves anybody beside residents", () => {
    const { container } = renderPanel([pluginWith({ nonResidentCallers: [] })]);

    expect(container.textContent).toBe("");
  });

  it("names each approved class, whether it is served, and who consented and withdrew", () => {
    renderPanel([pluginWith()]);

    expect(
      screen.getByText("styrelseledamöter som inte bor i huset"),
    ).toBeTruthy();
    expect(screen.getByText("förvaltaren, en extern part")).toBeTruthy();
    expect(screen.getByText("Betjänas")).toBeTruthy();
    // The state is a word as well as whatever the theme makes of it.
    expect(screen.getAllByText("Tillbakadragen")).toHaveLength(1);
    expect(screen.getAllByText("Godkänd av Anna Admin")).toHaveLength(2);
    expect(
      screen.getByText(
        "Tillbakadragen av ett konto som inte längre finns i registret",
      ),
    ).toBeTruthy();
  });

  it("offers no buttons to a reader who may not manage plugins", () => {
    renderPanel([pluginWith()], false);

    expect(screen.queryByRole("button")).toBeNull();
  });
});

describe("withdrawing and consenting again", () => {
  it("withdraws a served class and reads the overview again", async () => {
    renderPanel([pluginWith()]);

    await userEvent.click(screen.getByRole("button", { name: "Dra tillbaka" }));

    expect(setPluginNonResidentCallerWithdrawn).toHaveBeenCalledWith(
      "parkering",
      "board",
      true,
    );
    await waitFor(() => {
      expect(onChanged).toHaveBeenCalledTimes(1);
    });
  });

  it("consents again to a withdrawn class", async () => {
    renderPanel([pluginWith()]);

    await userEvent.click(screen.getByRole("button", { name: "Godkänn igen" }));

    expect(setPluginNonResidentCallerWithdrawn).toHaveBeenCalledWith(
      "parkering",
      "propertyManager",
      false,
    );
    await waitFor(() => {
      expect(onChanged).toHaveBeenCalledTimes(1);
    });
  });

  it("says so when the change fails, reads nothing again, and clears the notice on the next try", async () => {
    setPluginNonResidentCallerWithdrawn.mockResolvedValueOnce({
      ok: false,
      failure: { status: 500, reason: "unexpected" },
    });
    renderPanel([pluginWith()]);

    await userEvent.click(screen.getByRole("button", { name: "Dra tillbaka" }));

    expect(await screen.findByText("Gruppen kunde inte ändras")).toBeTruthy();
    expect(onChanged).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: "Dra tillbaka" }));

    await waitFor(() => {
      expect(screen.queryByText("Gruppen kunde inte ändras")).toBeNull();
    });
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it("sends one change at a time while one is in flight", async () => {
    let settle: (value: unknown) => void = () => undefined;
    setPluginNonResidentCallerWithdrawn.mockReturnValueOnce(
      new Promise((resolve) => {
        settle = resolve;
      }),
    );
    renderPanel([pluginWith()]);
    const button = screen.getByRole("button", { name: "Dra tillbaka" });

    await userEvent.click(button);
    await userEvent.click(button);

    expect(setPluginNonResidentCallerWithdrawn).toHaveBeenCalledTimes(1);
    settle({ ok: true, value: undefined });
    await waitFor(() => {
      expect(onChanged).toHaveBeenCalledTimes(1);
    });
  });
});

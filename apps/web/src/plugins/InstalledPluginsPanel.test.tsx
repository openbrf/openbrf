import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import "../i18n";
import { InstalledPluginsPanel } from "./InstalledPluginsPanel";
import type { PluginSummary } from "./plugin-api";

/**
 * The plugins this instance runs.
 *
 * The consent screen is seen once, by whoever installed. This panel is where
 * every later board reads the same declaration, which is why each row states
 * the permissions and the personal data in sentences rather than only naming
 * the plugin. The state word matters for the same reason: "installed but not
 * running" has three causes a board acts on differently, and a row that showed
 * a single on/off flag would hide two of them.
 */

const setPluginEnabled = vi.fn();
const uninstallPlugin = vi.fn();
const fetchPluginSettings = vi.fn();

vi.mock("./plugin-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./plugin-api")>()),
  setPluginEnabled: (id: string, enabled: boolean) =>
    setPluginEnabled(id, enabled),
  uninstallPlugin: (id: string) => uninstallPlugin(id),
  fetchPluginSettings: (id: string) => fetchPluginSettings(id),
}));

// Typed, so a field added or retyped in the API client breaks this fixture
// rather than leaving the tests passing against a shape the API no longer
// returns.
function pluginWith(overrides: Partial<PluginSummary> = {}): PluginSummary {
  return {
    id: "grannsamverkan",
    packageName: "@openbrf/plugin-grannsamverkan",
    version: "1.2.0",
    enabled: true,
    status: "INSTALLED",
    lastError: null,
    loaded: true,
    permissions: ["addressBook:read", "mail:send"],
    personalData: ["name", "email"],
    installedAt: "2026-08-20T09:00:00.000Z",
    hasSettings: false,
    view: null,
    ...overrides,
  };
}

const onChanged = vi.fn();
const onRestarting = vi.fn();

function renderPanel(plugins: PluginSummary[], editable = true) {
  return render(
    <InstalledPluginsPanel
      plugins={plugins}
      editable={editable}
      onChanged={onChanged}
      onRestarting={onRestarting}
    />,
  );
}

const removeButton = () => screen.getByRole("button", { name: "Ta bort" });

beforeEach(() => {
  onChanged.mockReset();
  onRestarting.mockReset();
  setPluginEnabled
    .mockReset()
    .mockResolvedValue({ ok: true, value: { restarting: true } });
  uninstallPlugin
    .mockReset()
    .mockResolvedValue({ ok: true, value: { restarting: true } });
  fetchPluginSettings.mockReset().mockResolvedValue({
    ok: true,
    value: { id: "grannsamverkan", schema: { fields: [] }, values: {} },
  });
});

describe("an instance with nothing installed", () => {
  it("says so rather than showing an empty list", () => {
    renderPanel([]);

    expect(screen.getByText("Inga tillägg är installerade.")).toBeTruthy();
  });
});

describe("a row", () => {
  it("restates the declaration in sentences, never as codes", () => {
    const { container } = renderPanel([pluginWith()]);

    expect(
      screen.getByText(
        "Läsa namn, lägenheter, vem som är boende och vem som är medlem, och inflyttnings- och utflyttningsdatum; Skicka e-post via föreningens egen server",
      ),
    ).toBeTruthy();
    expect(screen.getByText("Namn; E-postadress")).toBeTruthy();

    expect(container.textContent).not.toContain("addressBook:read");
    expect(container.textContent).not.toContain("mail:send");
  });

  it("says a plugin reaching nothing reaches nothing", () => {
    renderPanel([pluginWith({ permissions: [], personalData: [] })]);

    expect(
      screen.getByText("Ingenting utöver sina egna inställningar."),
    ).toBeTruthy();
    expect(screen.getByText("Inga.")).toBeTruthy();
  });

  it("shows the failure the loader recorded", () => {
    // Without it the row says only that the install failed, and the board has
    // nothing to give the plugin's author.
    renderPanel([
      pluginWith({
        status: "FAILED",
        loaded: false,
        lastError: "Cannot find module './entry.js'",
      }),
    ]);

    expect(screen.getByText("Cannot find module './entry.js'")).toBeTruthy();
  });
});

describe("the state word", () => {
  it("reads running when the plugin is on and its code is loaded", () => {
    renderPanel([pluginWith()]);

    expect(screen.getByText("Körs")).toBeTruthy();
  });

  it("reads switched off when the board turned it off", () => {
    renderPanel([pluginWith({ enabled: false, loaded: false })]);

    expect(screen.getByText("Avstängt")).toBeTruthy();
  });

  it("reads installation failed when the install did not complete", () => {
    renderPanel([pluginWith({ status: "FAILED", loaded: false })]);

    expect(screen.getByText("Installationen misslyckades")).toBeTruthy();
  });

  it("reads awaiting restart when the code is not in this process yet", () => {
    // The distinction a board acts on: nothing is wrong, the server has not
    // been replaced yet.
    renderPanel([pluginWith({ loaded: false })]);

    expect(screen.getByText("Installerat, väntar på omstart")).toBeTruthy();
  });
});

describe("removing a plugin", () => {
  it("asks before it removes anything", async () => {
    /*
     * A removal deletes the plugin's settings with it and restarts the server.
     * A single press next to the switch-off button would make that a slip of
     * the hand, so the first press only asks.
     */
    const session = userEvent.setup();
    renderPanel([pluginWith()]);

    await session.click(removeButton());

    expect(uninstallPlugin).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Ja, ta bort" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Behåll" })).toBeTruthy();
    expect(
      screen.getByText(
        "Tilläggets inställningar tas bort tillsammans med det, och programmet startas om för att sluta köra dess kod.",
      ),
    ).toBeTruthy();
  });

  it("removes on the second press", async () => {
    const session = userEvent.setup();
    renderPanel([pluginWith()]);

    await session.click(removeButton());
    await session.click(screen.getByRole("button", { name: "Ja, ta bort" }));

    await waitFor(() => {
      expect(uninstallPlugin).toHaveBeenCalledWith("grannsamverkan");
    });
  });

  it("goes back to the single button when the board keeps it", async () => {
    const session = userEvent.setup();
    renderPanel([pluginWith()]);

    await session.click(removeButton());
    await session.click(screen.getByRole("button", { name: "Behåll" }));

    expect(screen.queryByRole("button", { name: "Ja, ta bort" })).toBeNull();
    expect(removeButton()).toBeTruthy();
    expect(uninstallPlugin).not.toHaveBeenCalled();
  });
});

describe("the settings a row opens", () => {
  it("takes the failure notice down once a retry succeeds", async () => {
    // Otherwise the row shows the settings form and, directly above it, a
    // notice saying they could not be read - which leaves a board unable to
    // tell whether what it is about to edit is the plugin's real state.
    fetchPluginSettings.mockResolvedValueOnce({
      ok: false,
      failure: { status: 500, reason: "unexpected" },
    });
    const session = userEvent.setup();
    renderPanel([pluginWith({ hasSettings: true })]);
    const settingsButton = screen.getByRole("button", {
      name: "Inställningar",
    });

    await session.click(settingsButton);
    await waitFor(() => {
      expect(
        screen.getByText("Det gick inte just nu. Försök igen."),
      ).toBeTruthy();
    });

    await session.click(settingsButton);

    await waitFor(() => {
      expect(
        screen.queryByText("Det gick inte just nu. Försök igen."),
      ).toBeNull();
    });
  });
});

describe("switching a plugin", () => {
  it("off asks the server to stop running it", async () => {
    const session = userEvent.setup();
    renderPanel([pluginWith()]);

    await session.click(screen.getByRole("button", { name: "Stäng av" }));

    await waitFor(() => {
      expect(setPluginEnabled).toHaveBeenCalledWith("grannsamverkan", false);
    });
  });

  it("on asks the server to run it again", async () => {
    const session = userEvent.setup();
    renderPanel([pluginWith({ enabled: false, loaded: false })]);

    await session.click(screen.getByRole("button", { name: "Slå på" }));

    await waitFor(() => {
      expect(setPluginEnabled).toHaveBeenCalledWith("grannsamverkan", true);
    });
  });
});

/**
 * What an action that ends in a restart must not do.
 *
 * The server answered the request and is now draining the connection it came
 * in on, so a read at that moment is a read against a process that is going
 * away. Its failure would put a "could not be read" notice on a row for an
 * action that worked, which is the screen telling a board the opposite of what
 * happened. The screen's restart poll does the read once the replacement
 * answers.
 */
describe("an action the server restarts for", () => {
  it("hands over to the restart poll rather than reading again", async () => {
    const session = userEvent.setup();
    renderPanel([pluginWith()]);

    await session.click(screen.getByRole("button", { name: "Stäng av" }));

    await waitFor(() => {
      expect(onRestarting).toHaveBeenCalledOnce();
    });
    expect(onChanged).not.toHaveBeenCalled();
  });

  it("reads again when no restart was asked for", async () => {
    // The other half: an action that changed something without replacing the
    // process still has to refresh the row it changed.
    setPluginEnabled.mockResolvedValue({ ok: true, value: {} });
    const session = userEvent.setup();
    renderPanel([pluginWith()]);

    await session.click(screen.getByRole("button", { name: "Stäng av" }));

    await waitFor(() => {
      expect(onChanged).toHaveBeenCalledOnce();
    });
    expect(onRestarting).not.toHaveBeenCalled();
  });
});

describe("a board member who may only read", () => {
  it("is offered no action at all", () => {
    // Hiding the controls is courtesy - the API refuses the call either way -
    // but a remove button that always fails trains a board to ignore refusals.
    renderPanel([pluginWith({ hasSettings: true })], false);

    expect(screen.queryAllByRole("button")).toHaveLength(0);
  });
});

import {
  PLUGIN_INSTALL_FAILURE_REASONS,
  type PluginInstallFailureReason,
} from "@openbrf/shared";
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
    failure: null,
    loaded: true,
    permissions: ["addressBook:read", "mail:send"],
    personalData: ["name", "email"],
    consentedActions: [],
    armedActions: [],
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

  it("shows a failure recorded before failures carried a code as it stands", () => {
    // Without it the row says only that the install failed, and the board has
    // nothing to give the plugin's author. A row written before the reason
    // column existed has nothing else to show.
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

/**
 * The values each reason's sentence is completed with, as the installer
 * records them. Typed against the union, so a reason added there needs an
 * entry here before this file compiles.
 */
const DETAIL: Readonly<
  Record<PluginInstallFailureReason, Record<string, string | number>>
> = {
  "download-budget-spent": { budgetMs: 480_000 },
  "download-timed-out": { timeoutMs: 300_000 },
  "source-not-allowed": {},
  "source-unreachable": {},
  "source-answered-error": { status: 404 },
  "archive-too-large": { maxBytes: 64 * 1024 * 1024 },
  "checksum-malformed": {},
  "checksum-mismatch": {},
  "download-failed": {},
  "archive-unreadable": { packageName: "@openbrf/plugin-grannsamverkan" },
  "archive-not-a-plugin": { packageName: "@openbrf/plugin-grannsamverkan" },
  "archive-package-mismatch": {
    packageName: "@openbrf/plugin-grannsamverkan",
    version: "1.2.0",
    heldName: "@openbrf/plugin-grannsamverkan",
    heldVersion: "1.1.0",
  },
  "npm-install-failed": {},
  "package-not-installed": { packageName: "@openbrf/plugin-grannsamverkan" },
  "unconsented-packages": { packages: "left-pad, is-odd" },
  "installation-claim-lost": {},
  "build-failed": {},
};

function failedWith(
  reason: string,
  detail: Record<string, string | number> = {},
): PluginSummary {
  return pluginWith({
    status: "FAILED",
    loaded: false,
    lastError: "PluginInstallError: what the server threw, in English.",
    failure: { reason, detail },
  });
}

describe("a failed install", () => {
  it.each([...PLUGIN_INSTALL_FAILURE_REASONS])(
    "reads %s as a sentence in the board's language",
    (reason) => {
      const { container } = renderPanel([failedWith(reason, DETAIL[reason])]);

      const text = container.textContent ?? "";
      // Nothing left to interpolate, and not the key itself, which is what
      // i18next renders for a key missing from the resources.
      expect(text).not.toContain("{{");
      expect(text).not.toContain("plugins.installed.failure");
      expect(text).not.toContain(reason);
      // What the server threw is the operator's, and stays off this screen.
      expect(text).not.toContain("what the server threw");
    },
  );

  it("gives each reason a sentence that is not another reason's", () => {
    const sentences = PLUGIN_INSTALL_FAILURE_REASONS.map((reason) => {
      const view = renderPanel([failedWith(reason, DETAIL[reason])]);
      const text = view.container.textContent ?? "";
      view.unmount();
      return text;
    });

    expect(new Set(sentences).size).toBe(PLUGIN_INSTALL_FAILURE_REASONS.length);
  });

  it("states the download budget in seconds rather than milliseconds", () => {
    renderPanel([failedWith("download-budget-spent", { budgetMs: 480_000 })]);

    expect(
      screen.getByText(
        "Körningens nedladdningar hade använt sina 480 sekunder innan det här tillägget stod på tur, så det hämtades inte. En ny installation startar en ny körning.",
      ),
    ).toBeTruthy();
  });

  it("says one second, not one seconds, when a deadline was cut that short", () => {
    renderPanel([failedWith("download-timed-out", { timeoutMs: 400 })]);

    expect(
      screen.getByText(
        "Tilläggets arkiv blev inte färdighämtat inom 1 sekund. Servern som har det kan vara långsam eller otillgänglig.",
      ),
    ).toBeTruthy();
  });

  it("states the size cap in MiB rather than bytes", () => {
    renderPanel([
      failedWith("archive-too-large", { maxBytes: 64 * 1024 * 1024 }),
    ]);

    expect(
      screen.getByText(
        "Tilläggets arkiv är större än de 64 MiB som en instans tar emot.",
      ),
    ).toBeTruthy();
  });

  it("names a reason this version has no sentence for rather than hiding it", () => {
    renderPanel([failedWith("registry-on-fire")]);

    expect(
      screen.getByText(
        "Installationen misslyckades av en anledning som den här versionen saknar formulering för: registry-on-fire",
      ),
    ).toBeTruthy();
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

  it("says why when other package changes were still running", async () => {
    // The API refuses a removal while an install or another removal of the
    // same id holds its lock, and while the instance is already running as
    // many plugin and theme changes as it admits. The sentence names both, and
    // says the same press is worth making again, rather than the general one
    // about a failure.
    uninstallPlugin.mockResolvedValueOnce({
      ok: false,
      failure: { status: 429, reason: "package-busy" },
    });
    const session = userEvent.setup();
    renderPanel([pluginWith()]);

    await session.click(removeButton());
    await session.click(screen.getByRole("button", { name: "Ja, ta bort" }));

    expect(
      await screen.findByText(
        "Tillägget togs inte bort, eftersom en annan ändring av det, eller av andra tillägg och teman, pågick. Vänta en stund och försök igen.",
      ),
    ).toBeTruthy();
    expect(
      screen.queryByText("Det gick inte just nu. Försök igen."),
    ).toBeNull();
    expect(onRestarting).not.toHaveBeenCalled();
  });

  it("keeps the general sentence for any other refusal", async () => {
    uninstallPlugin.mockResolvedValueOnce({
      ok: false,
      failure: { status: 404, reason: "plugin-not-installed" },
    });
    const session = userEvent.setup();
    renderPanel([pluginWith()]);

    await session.click(removeButton());
    await session.click(screen.getByRole("button", { name: "Ja, ta bort" }));

    expect(
      await screen.findByText("Det gick inte just nu. Försök igen."),
    ).toBeTruthy();
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

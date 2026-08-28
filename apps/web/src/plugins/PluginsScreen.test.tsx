import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import "../i18n";
import type { Viewer } from "../api/instance";
import type { CatalogPlugin, PluginsOverview } from "./plugin-api";
import { PluginsScreen } from "./PluginsScreen";

/**
 * What each viewer is offered, and what an install actually sends.
 *
 * Reading the list needs association:read because the board answers for what
 * runs on the instance; installing needs association:manage. Hiding the catalog
 * is courtesy - the API enforces the same rules - but offering a route to an
 * install that will be refused trains a board to ignore refusals.
 *
 * The install request carries back the declaration the consent screen showed.
 * The API compares it with the catalog and refuses a mismatch, so a board never
 * installs on the strength of a screen that has since become wrong; sending
 * anything other than what was on screen would defeat that check.
 */

const fetchPlugins = vi.fn();
const fetchCatalog = vi.fn();
const installPlugin = vi.fn();

vi.mock("./plugin-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./plugin-api")>()),
  fetchPlugins: () => fetchPlugins(),
  fetchCatalog: () => fetchCatalog(),
  installPlugin: (input: unknown) => installPlugin(input),
}));

const ENTRY: CatalogPlugin = {
  id: "grannsamverkan",
  packageName: "@openbrf/plugin-grannsamverkan",
  version: "1.2.0",
  name: { sv: "Grannsamverkan", en: "Neighbourhood watch" },
  description: {
    sv: "Skickar ut grannsamverkansbrev till de boende.",
    en: "Sends neighbourhood watch letters to residents.",
  },
  homepage: null,
  deprecated: false,
  apiVersion: 1,
  permissions: ["addressBook:read", "mail:send"],
  personalData: ["name", "email"],
  supported: true,
  installedVersion: null,
};

const OVERVIEW: PluginsOverview = {
  pluginsEnabled: true,
  restartPending: false,
  plugins: [],
  findings: [],
};

function viewerWith(capabilities: string[]): Viewer {
  return {
    personId: "person-1",
    firstName: "Anna",
    lastName: "Andersson",
    preferredLocale: "sv",
    capabilities,
    housingCooperative: {
      name: "Brf Eksemplet",
      primaryColor: null,
      logoPath: null,
    },
  };
}

function renderScreen(capabilities: string[]) {
  return render(<PluginsScreen viewer={viewerWith(capabilities)} />);
}

const installedHeading = () =>
  screen.queryByRole("heading", { name: "Installerade tillägg" });
const catalogHeading = () => screen.queryByRole("heading", { name: "Katalog" });
const consentHeading = () =>
  screen.queryByRole("heading", { name: "Granska innan installation" });

/** Opens the consent screen for the one catalog entry. */
async function choose(session: ReturnType<typeof userEvent.setup>) {
  await session.click(
    await screen.findByRole("button", { name: /^installera$/i }),
  );
}

beforeEach(() => {
  fetchPlugins.mockReset().mockResolvedValue({ ok: true, value: OVERVIEW });
  fetchCatalog.mockReset().mockResolvedValue({
    ok: true,
    value: {
      source: "https://catalog.openbrf.se/index.json",
      entries: [ENTRY],
    },
  });
  installPlugin
    .mockReset()
    .mockResolvedValue({ ok: true, value: { restarting: false } });
});

describe("a board member who may only read", () => {
  it("sees what runs and is offered no way to install", async () => {
    renderScreen(["association:read"]);

    await waitFor(() => {
      expect(installedHeading()).toBeTruthy();
    });
    expect(catalogHeading()).toBeNull();
    // The catalog is never even read: it is the route to an install, and an
    // install is an admin action.
    expect(fetchCatalog).not.toHaveBeenCalled();
  });
});

describe("an admin", () => {
  it("sees what runs and what can be installed", async () => {
    renderScreen(["association:read", "association:manage"]);

    await waitFor(() => {
      expect(installedHeading()).toBeTruthy();
    });
    expect(catalogHeading()).toBeTruthy();
  });
});

describe("a viewer with neither capability", () => {
  it("is told the page is not theirs, and nothing is read", async () => {
    renderScreen(["self:manage"]);

    await waitFor(() => {
      expect(
        screen.getByText("Ditt konto får inte se den här sidan."),
      ).toBeTruthy();
    });
    expect(installedHeading()).toBeNull();
    expect(catalogHeading()).toBeNull();
    expect(fetchPlugins).not.toHaveBeenCalled();
  });
});

describe("choosing a plugin from the catalog", () => {
  it("opens the consent screen instead of installing", async () => {
    const session = userEvent.setup();
    renderScreen(["association:read", "association:manage"]);

    await choose(session);

    expect(consentHeading()).toBeTruthy();
    // The catalog gives way, so the declaration is the only thing being read.
    expect(catalogHeading()).toBeNull();
    expect(installPlugin).not.toHaveBeenCalled();
  });

  it("returns to the catalog when the board backs out", async () => {
    const session = userEvent.setup();
    renderScreen(["association:read", "association:manage"]);

    await choose(session);
    await session.click(screen.getByRole("button", { name: /^avbryt$/i }));

    await waitFor(() => {
      expect(catalogHeading()).toBeTruthy();
    });
    expect(consentHeading()).toBeNull();
    expect(installPlugin).not.toHaveBeenCalled();
  });
});

describe("confirming the consent", () => {
  it("sends back exactly the declaration that was on screen", async () => {
    const session = userEvent.setup();
    renderScreen(["association:read", "association:manage"]);

    await choose(session);
    await session.click(screen.getByRole("checkbox"));
    await session.click(screen.getByRole("button", { name: /^installera$/i }));

    await waitFor(() => {
      expect(installPlugin).toHaveBeenCalledWith({
        id: "grannsamverkan",
        permissions: ["addressBook:read", "mail:send"],
        personalData: ["name", "email"],
      });
    });
  });

  it("says the application is being replaced when it is", async () => {
    // The request is answered before the restart, and this page is holding one
    // of the connections being drained, so the screen says so rather than
    // appearing to hang.
    installPlugin.mockResolvedValue({ ok: true, value: { restarting: true } });
    const session = userEvent.setup();
    renderScreen(["association:read", "association:manage"]);

    await choose(session);
    await session.click(screen.getByRole("checkbox"));
    await session.click(screen.getByRole("button", { name: /^installera$/i }));

    await waitFor(() => {
      expect(
        screen.getByText(
          "Programmet startas om för att läsa in ändringen. Ladda om sidan om en liten stund.",
        ),
      ).toBeTruthy();
    });
  });
});

describe("an instance with plugins switched off", () => {
  it("says nothing can be installed until they are switched on", async () => {
    fetchPlugins.mockResolvedValue({
      ok: true,
      value: { ...OVERVIEW, pluginsEnabled: false },
    });

    renderScreen(["association:read", "association:manage"]);

    await waitFor(() => {
      expect(
        screen.getByText(
          "Tillägg är avstängda på den här instansen. Inget kan installeras förrän de slås på igen.",
        ),
      ).toBeTruthy();
    });
  });
});

describe("a failed read", () => {
  it("names the failure rather than showing an empty instance", async () => {
    // Rendered as "no plugins are installed", a failed read tells a board that
    // something they installed is gone.
    fetchPlugins.mockResolvedValue({
      ok: false,
      failure: { status: 500, reason: "unexpected" },
    });

    renderScreen(["association:read", "association:manage"]);

    await waitFor(() => {
      expect(
        screen.getByText(
          "Listan över tillägg kunde inte läsas just nu. Ladda om sidan.",
        ),
      ).toBeTruthy();
    });
    expect(installedHeading()).toBeNull();
  });
});

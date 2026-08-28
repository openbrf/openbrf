import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import "../i18n";
import { ConsentPanel, type ConsentPanelProps } from "./ConsentPanel";
import type { CatalogPlugin } from "./plugin-api";

/**
 * The consent gate.
 *
 * A backend plugin runs at full process privilege, so this screen is the whole
 * of what a board is given before it becomes answerable under GDPR for what a
 * plugin does and which personal data it reaches. Three things therefore have
 * to hold: the declaration is stated in sentences a board can act on rather
 * than in permission codes, the two limits that hold whatever a plugin asked
 * for are always on screen, and nothing installs until the acknowledgement is
 * actually ticked - a screen that installs on the first press has recorded a
 * consent nobody gave.
 */

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
  permissions: ["addressBook:read", "addressBook:readContact", "mail:send"],
  personalData: ["name", "apartment", "email"],
  supported: true,
  installedVersion: null,
};

function renderPanel(overrides: Partial<ConsentPanelProps> = {}) {
  return render(
    <ConsentPanel
      entry={ENTRY}
      locale="sv"
      onConfirm={vi.fn()}
      onCancel={vi.fn()}
      {...overrides}
    />,
  );
}

const installButton = () =>
  screen.getByRole("button", { name: /^installera$/i });
const cancelButton = () => screen.getByRole("button", { name: /^avbryt$/i });
const acknowledgement = () => screen.getByRole("checkbox");

describe("the declaration", () => {
  it("states each permission as a sentence, never as its code", () => {
    // A board consents to what a plugin may do, and "addressBook:readContact"
    // does not say that contact details leave the board's own screens.
    const { container } = renderPanel();

    expect(
      screen.getByText(
        "Läsa namn, lägenheter, vem som är boende och vem som är medlem, och inflyttnings- och utflyttningsdatum",
      ),
    ).toBeTruthy();
    expect(
      screen.getByText("Läsa e-postadresser och telefonnummer"),
    ).toBeTruthy();
    expect(
      screen.getByText("Skicka e-post via föreningens egen server"),
    ).toBeTruthy();

    expect(container.textContent).not.toContain("addressBook:read");
    expect(container.textContent).not.toContain("addressBook:readContact");
    expect(container.textContent).not.toContain("mail:send");
  });

  it("states each personal data category as a sentence, never as its code", () => {
    const { container } = renderPanel();

    expect(screen.getByText("Namn")).toBeTruthy();
    expect(screen.getByText("Lägenhet och adress")).toBeTruthy();
    expect(screen.getByText("E-postadress")).toBeTruthy();

    expect(container.textContent).not.toContain("apartment");
  });

  it("says what a plugin asking for nothing amounts to", () => {
    // An empty list reads as a screen that failed to load. The sentence is what
    // tells a board that this plugin reaches no further than its own settings.
    renderPanel({
      entry: { ...ENTRY, permissions: [], personalData: [] },
    });

    expect(
      screen.getByText("Ingenting utöver sina egna inställningar."),
    ).toBeTruthy();
    expect(screen.getByText("Inga.")).toBeTruthy();
  });
});

describe("the standing limits", () => {
  const privacyNote = () => screen.queryByText(/personnummer/i);

  it("are stated for a plugin that asked for everything", () => {
    renderPanel();

    expect(privacyNote()).toBeTruthy();
  });

  it("are stated for a plugin that asked for nothing", () => {
    /*
     * The note is not a summary of the declaration above it. A board reading a
     * list of permissions has no other way to know where the list stops, so it
     * has to hold whatever the plugin declared - including for a plugin whose
     * declaration is empty and whose list therefore says nothing at all.
     */
    renderPanel({
      entry: { ...ENTRY, permissions: [], personalData: [] },
    });

    expect(privacyNote()).toBeTruthy();
    expect(screen.getByText(/skyddade personuppgifter/i)).toBeTruthy();
  });
});

describe("the acknowledgement", () => {
  it("holds the install button shut until it is ticked", async () => {
    const session = userEvent.setup();
    renderPanel();

    expect(installButton()).toHaveProperty("disabled", true);

    await session.click(acknowledgement());

    expect(installButton()).toHaveProperty("disabled", false);
  });

  it("shuts the install button again when it is unticked", async () => {
    // The gate is the checkbox's current state, not the fact that it was
    // touched once.
    const session = userEvent.setup();
    renderPanel();

    await session.click(acknowledgement());
    await session.click(acknowledgement());

    expect(installButton()).toHaveProperty("disabled", true);
  });

  it("is what lets the install through", async () => {
    const onConfirm = vi.fn();
    const session = userEvent.setup();
    renderPanel({ onConfirm });

    await session.click(installButton());
    expect(onConfirm).not.toHaveBeenCalled();

    await session.click(acknowledgement());
    await session.click(installButton());

    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("is not needed to walk away", async () => {
    const onCancel = vi.fn();
    const session = userEvent.setup();
    renderPanel({ onCancel });

    await session.click(cancelButton());

    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});

describe("while the install runs", () => {
  it("says so and takes no second press", async () => {
    // Installing replaces the server process. A second press would be a second
    // install request against a server that is on its way down.
    const session = userEvent.setup();
    renderPanel({ busy: true });

    await session.click(acknowledgement());

    const confirm = screen.getByRole("button", { name: /^installerar/i });
    expect(confirm).toHaveProperty("disabled", true);
    expect(cancelButton()).toHaveProperty("disabled", true);
  });
});

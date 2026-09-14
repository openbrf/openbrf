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
  permissions: [
    "addressBook:read",
    "addressBook:readContact",
    "mail:send",
    "sms:send",
  ],
  personalData: ["name", "apartment", "email"],
  actions: [
    {
      id: "list_letters",
      capability: "news:read",
      effect: "read",
      personalData: ["name"],
      surfaces: ["ui"],
    },
    {
      id: "request_mailing",
      capability: "news:write",
      effect: "write",
      personalData: ["name", "email"],
      surfaces: ["ui", "mcp"],
    },
  ],
  oauthProtectedResource: null,
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
    // SMS is stated apart from mail, and stated with what it costs and who
    // pays it: a board weighing this one is agreeing to spend a provider
    // contract, so the sentence names the cooperative as the party billed
    // rather than leaving the clause to attach to the provider.
    expect(
      screen.getByText(
        "Skicka sms via föreningens sms-leverantör; föreningen debiteras per meddelande",
      ),
    ).toBeTruthy();

    expect(container.textContent).not.toContain("addressBook:read");
    expect(container.textContent).not.toContain("addressBook:readContact");
    expect(container.textContent).not.toContain("mail:send");
    expect(container.textContent).not.toContain("sms:send");
  });

  it("states each personal data category as a sentence, never as its code", () => {
    const { container } = renderPanel();

    expect(screen.getByText("Namn")).toBeTruthy();
    expect(screen.getByText("Lägenhet och adress")).toBeTruthy();
    expect(screen.getByText("E-postadress")).toBeTruthy();

    expect(container.textContent).not.toContain("apartment");
  });

  it("states each action it proposes with what it does to the records", () => {
    /*
     * The widest part of the declaration: an action names a capability and
     * offers it to callers outside the board's own screens. The effect is what
     * separates one that reads the register from one that deletes out of it,
     * so it is a word rather than a code, and it is on screen before anything
     * is downloaded - the catalog entry carries the declaration for exactly
     * that reason.
     *
     * The personal data and the surfaces are stated per action, not only in
     * the plugin-wide list above. That list says which categories the plugin
     * touches somewhere; it cannot say which action receives each, and it says
     * nothing about how far one may be offered. The two entries here differ in
     * both, which is the point: a board consenting to `request_mailing` is
     * consenting to an address leaving for a connected app, and the aggregate
     * list would have shown the same words for an action that does neither.
     */
    renderPanel();

    expect(screen.getByRole("heading", { name: "Åtgärder" })).toBeTruthy();
    expect(
      screen.getByText(
        "list_letters - news:read - Läser - Namn - I den här instansen",
      ),
    ).toBeTruthy();
    expect(
      screen.getByText(
        "request_mailing - news:write - Skriver - Namn, E-postadress - " +
          "I den här instansen, Anslutna appar",
      ),
    ).toBeTruthy();
  });

  it("says so where an action touches no personal data at all", () => {
    // A blank would read as a declaration that failed to render. "None" is an
    // answer the board can act on; an empty gap is not.
    renderPanel({
      entry: {
        ...ENTRY,
        actions: [
          {
            id: "ping",
            capability: "self:manage",
            effect: "read",
            personalData: [],
            surfaces: ["ui"],
          },
        ],
      },
    });

    expect(
      screen.getByText(
        "ping - self:manage - Läser - Inga personuppgifter - I den här instansen",
      ),
    ).toBeTruthy();
  });

  it("says nothing at all about actions when a plugin proposes none", () => {
    /*
     * Absent rather than empty, unlike the two lists above it. Those answer a
     * question a board has whatever the plugin asked for - what may it do,
     * whose data does it touch - and "nothing" is an answer to it. A plugin
     * that proposes no action has not raised the question, and a heading with
     * a sentence under it saying so would introduce a mechanism this install
     * does not use.
     */
    renderPanel({ entry: { ...ENTRY, actions: [] } });

    expect(screen.queryByRole("heading", { name: "Åtgärder" })).toBeNull();
    expect(
      screen.getByRole("heading", { name: "Det här tillägget får" }),
    ).toBeTruthy();
  });

  it("says what serving the connected-app sign-in address amounts to", () => {
    /*
     * The one declaration that decides something about the instance rather
     * than about the plugin. A board reading the lists above it has no way to
     * tell that this install also moves where connected apps sign in, that no
     * second plugin can serve it, and that the address stops answering the
     * session they are signed in with - so the screen says all three before
     * the acknowledgement, in words a board member can act on.
     */
    renderPanel({ entry: { ...ENTRY, oauthProtectedResource: "mcp" } });

    expect(
      screen.getByRole("heading", { name: "Inloggning för anslutna appar" }),
    ).toBeTruthy();
    expect(
      screen.getByText(
        "Det här tillägget kommer att betjäna den adress som anslutna appar loggar in mot.",
      ),
    ).toBeTruthy();
    expect(
      screen.getByText("Bara ett installerat tillägg i taget kan göra det."),
    ).toBeTruthy();
    expect(
      screen.getByText(
        "Adressen slutar svara på en vanlig inloggning i webbläsaren och nås bara av anslutna appar.",
      ),
    ).toBeTruthy();
  });

  it("states it without the route or the machinery behind it", () => {
    // What full address the route composes to is the server's answer, and a
    // board member is not the one who acts on the path or on the protocol the
    // sign-in uses.
    const { container } = renderPanel({
      entry: { ...ENTRY, oauthProtectedResource: "mcp" },
    });

    expect(container.textContent).not.toContain("mcp");
    expect(container.textContent).not.toMatch(/oauth|bearer|token/i);
  });

  it("says nothing about sign-in when the plugin serves no such route", () => {
    /*
     * Absent rather than empty, like the actions list. A plugin that serves no
     * connected-app sign-in has not raised the question, and a heading about
     * it would put a mechanism on the screen that this install does not use.
     */
    renderPanel();

    expect(
      screen.queryByRole("heading", { name: "Inloggning för anslutna appar" }),
    ).toBeNull();
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

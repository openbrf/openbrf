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
  recipientState: "notRecorded",
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

const nothingLeaves = () =>
  screen.getByRole("radio", {
    name: "Nej, det skickar inga personuppgifter utanför instansen",
  });
const somethingLeaves = () =>
  screen.getByRole("radio", {
    name: "Ja, det skickar personuppgifter till en mottagare utanför instansen",
  });
const recipientField = () => screen.getByRole("textbox", { name: "Mottagare" });
const asProcessor = () =>
  screen.getByRole("radio", { name: "Personuppgiftsbiträde" });
const asIndependentController = () =>
  screen.getByRole("radio", { name: "Egen personuppgiftsansvarig" });

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
  // The question below is answered first in each of these, so the button's
  // state is the acknowledgement's alone.

  it("holds the install button shut until it is ticked", async () => {
    const session = userEvent.setup();
    renderPanel();
    await session.click(nothingLeaves());

    expect(installButton()).toHaveProperty("disabled", true);

    await session.click(acknowledgement());

    expect(installButton()).toHaveProperty("disabled", false);
  });

  it("shuts the install button again when it is unticked", async () => {
    // The gate is the checkbox's current state, not the fact that it was
    // touched once.
    const session = userEvent.setup();
    renderPanel();
    await session.click(nothingLeaves());

    await session.click(acknowledgement());
    await session.click(acknowledgement());

    expect(installButton()).toHaveProperty("disabled", true);
  });

  it("is what lets the install through", async () => {
    const onConfirm = vi.fn();
    const session = userEvent.setup();
    renderPanel({ onConfirm });
    await session.click(nothingLeaves());

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

/**
 * The one question the catalog cannot answer.
 *
 * Whether a plugin sends personal data outside the instance decides what it is
 * in the art. 28 record, and the install request is what writes that record.
 * So the screen asks it on every install, offers no answer of its own, and
 * lets nothing through until the answer is one the API records rather than
 * refuses, so that the board sees which field to correct next to it and not a
 * failed install.
 */
describe("where the plugin sends personal data", () => {
  it("is asked with neither answer chosen, even of a plugin declaring no personal data", async () => {
    /*
     * The declaration says what a plugin handles, not where it sends it, and a
     * plugin runs at full process privilege. An empty list is therefore no
     * ground for answering "no" on the board's behalf.
     */
    renderPanel({ entry: { ...ENTRY, permissions: [], personalData: [] } });

    expect(
      screen.getByRole("group", {
        name: "Skickar tillägget personuppgifter utanför instansen?",
      }),
    ).toBeTruthy();
    expect(nothingLeaves()).toHaveProperty("checked", false);
    expect(somethingLeaves()).toHaveProperty("checked", false);
  });

  it("holds the install button shut until it is answered", async () => {
    const session = userEvent.setup();
    renderPanel();

    await session.click(acknowledgement());
    expect(installButton()).toHaveProperty("disabled", true);

    await session.click(nothingLeaves());
    expect(installButton()).toHaveProperty("disabled", false);
  });

  it("sends that nothing leaves the instance, and no recipient", async () => {
    const onConfirm = vi.fn();
    const session = userEvent.setup();
    renderPanel({ onConfirm });

    await session.click(nothingLeaves());
    await session.click(acknowledgement());
    await session.click(installButton());

    expect(onConfirm).toHaveBeenCalledWith({ sendsPersonalDataOutside: false });
  });

  it("asks who receives it and what they are, and sends both", async () => {
    /*
     * art. 30(1)(d) asks who receives the data, so "somewhere outside" is not
     * an answer. Which kind of recipient it is stays the board's call: the
     * classification starts unchosen, like the question above it.
     */
    const onConfirm = vi.fn();
    const session = userEvent.setup();
    renderPanel({ onConfirm });

    await session.click(somethingLeaves());
    await session.click(acknowledgement());
    expect(asProcessor()).toHaveProperty("checked", false);
    expect(asIndependentController()).toHaveProperty("checked", false);
    expect(installButton()).toHaveProperty("disabled", true);

    // Classified, and nobody named: blanks are nobody.
    await session.click(asProcessor());
    await session.type(recipientField(), "   ");
    expect(installButton()).toHaveProperty("disabled", true);

    await session.type(recipientField(), "Beläggningstjänsten AB ");
    await session.click(installButton());

    expect(onConfirm).toHaveBeenCalledWith({
      sendsPersonalDataOutside: true,
      recipient: "Beläggningstjänsten AB",
      classification: "PROCESSOR",
    });
  });

  it("asks an independent controller why no agreement is needed", async () => {
    // The record keeps the reason for every recipient without an agreement,
    // and the API refuses one without it. The screen asks for it first, so the
    // board sees the missing field and not a failed install.
    const onConfirm = vi.fn();
    const session = userEvent.setup();
    renderPanel({ onConfirm });

    await session.click(somethingLeaves());
    await session.click(acknowledgement());
    await session.type(recipientField(), "Kartbolaget AB");
    // Named, and not yet classified.
    expect(installButton()).toHaveProperty("disabled", true);

    await session.click(asIndependentController());
    expect(installButton()).toHaveProperty("disabled", true);

    await session.type(
      screen.getByRole("textbox", { name: "Varför inget avtal behövs" }),
      "Bestämmer själv över sina kartdata.",
    );
    await session.click(installButton());

    expect(onConfirm).toHaveBeenCalledWith({
      sendsPersonalDataOutside: true,
      recipient: "Kartbolaget AB",
      classification: "INDEPENDENT_CONTROLLER",
      note: "Bestämmer själv över sina kartdata.",
    });
  });

  it("sends only the answer on screen when the board changes its mind", async () => {
    const onConfirm = vi.fn();
    const session = userEvent.setup();
    renderPanel({ onConfirm });

    await session.click(somethingLeaves());
    await session.type(recipientField(), "Beläggningstjänsten AB");
    await session.click(asProcessor());
    await session.click(nothingLeaves());
    await session.click(acknowledgement());
    await session.click(installButton());

    expect(onConfirm).toHaveBeenCalledWith({ sendsPersonalDataOutside: false });
  });

  it("keeps a personal identity number out of the record", async () => {
    // The API refuses one in what the board wrote. The screen says so next to
    // the field, so the board sees what to correct and not a failed install.
    const session = userEvent.setup();
    renderPanel();

    await session.click(somethingLeaves());
    await session.click(acknowledgement());
    await session.type(recipientField(), "Anna 811228-9874");
    await session.click(asProcessor());

    expect(screen.getByText("Skriv utan personnummer.")).toBeTruthy();
    expect(installButton()).toHaveProperty("disabled", true);
  });

  it("marks the field that holds one and says so through a region already in place", async () => {
    /*
     * A status region inserted together with its message can stay silent, so
     * the region is there, empty, from the moment "Ja" is answered, and only
     * its content comes and goes. The field holding the number says it is
     * invalid and names the message, so a screen-reader user learns which of
     * the two it is rather than only that one of them is wrong.
     */
    const session = userEvent.setup();
    renderPanel();

    await session.click(somethingLeaves());
    const region = screen.getByRole("status");
    expect(region.getAttribute("aria-live")).toBe("polite");
    expect(region.textContent).toBe("");
    expect(recipientField().getAttribute("aria-invalid")).toBeNull();

    await session.type(recipientField(), "Anna 811228-9874");
    expect(recipientField().getAttribute("aria-invalid")).toBe("true");
    const recipientMessage = document.getElementById(
      recipientField().getAttribute("aria-errormessage") ?? "",
    );
    expect(recipientMessage).toBe(region);
    expect(region.textContent).toContain("Skriv utan personnummer.");

    await session.clear(recipientField());
    await session.type(recipientField(), "Kartbolaget AB");
    expect(recipientField().getAttribute("aria-invalid")).toBeNull();
    expect(recipientField().getAttribute("aria-errormessage")).toBeNull();
    expect(region.textContent).toBe("");

    await session.click(asIndependentController());
    const note = screen.getByRole("textbox", {
      name: "Varför inget avtal behövs",
    });
    await session.type(note, "Enligt 811228-9874");
    expect(note.getAttribute("aria-invalid")).toBe("true");
    expect(
      document.getElementById(note.getAttribute("aria-errormessage") ?? ""),
    ).toBe(region);
    expect(region.textContent).toContain("Skriv utan personnummer.");
    // Only the field that holds it.
    expect(recipientField().getAttribute("aria-invalid")).toBeNull();
  });
});

describe("a plugin the record already classifies", () => {
  /*
   * A reinstall, an update, or a plugin removed and installed again. The step
   * asks only a few of the facts the record holds, so answering again would
   * replace an agreement the board has since completed on the data protection
   * screen - its date, reference and terms - with a pending one.
   */
  const RECORDED: CatalogPlugin = {
    ...ENTRY,
    installedVersion: "0.9.0",
    recipientState: "inPlace",
  };

  it("is not asked again, and says what the record keeps", () => {
    renderPanel({ entry: RECORDED });

    expect(screen.queryByRole("radio")).toBeNull();
    expect(screen.getByText(/Avtal finns/)).toBeTruthy();
  });

  it("installs on the acknowledgement alone and sends no answer", async () => {
    const onConfirm = vi.fn();
    const session = userEvent.setup();
    renderPanel({ entry: RECORDED, onConfirm });

    expect(installButton()).toHaveProperty("disabled", true);
    await session.click(acknowledgement());
    await session.click(installButton());

    expect(onConfirm).toHaveBeenCalledWith(null);
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

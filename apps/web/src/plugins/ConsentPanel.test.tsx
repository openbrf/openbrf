import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vite-plus/test";

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
  personRecords: [],
  permissions: [
    "addressBook:read",
    "addressBook:readContact",
    "mail:send",
    "sms:send",
  ],
  personalData: ["name", "apartment", "email"],
  processing: {
    purpose: {
      sv: "Skicka grannsamverkansbrev till de boende.",
      en: "Send neighbourhood watch letters to the residents.",
    },
    legalBasis: "legitimateInterest",
    legitimateInterest: {
      sv: "Att grannarna kan hålla uppsikt över huset.",
      en: "Neighbours keeping an eye on the building.",
    },
    retention: {
      sv: "Adresserna sparas inte efter utskicket.",
      en: "The addresses are not kept after the letter is sent.",
    },
    dataSubjects: ["members", "residents"],
  },
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
  extensionPoints: [],
  extends: [],
  holdsToBoard: [],
  recipients: [],
  deviceRoutes: [],
  residentRoutes: [],
  ai: false,
  licence: null,
  released: null,
  releaseNotCovered: null,
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
    name: "Nej, det varken skickar eller tar emot personuppgifter utanför instansen",
  });
const somethingLeaves = () =>
  screen.getByRole("radio", {
    name: "Ja, det skickar personuppgifter till, eller tar emot dem från, en mottagare utanför instansen",
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

  it("states each content permission as a sentence, never as its code", () => {
    // The board consents to a weekly digest reading the news without also
    // consenting to free/busy, so each is its own sentence (ADR 0032). The two
    // that read the board's text say that it may name people, and the one
    // that reads bookings says it never says who booked.
    const { container } = renderPanel({
      entry: {
        ...ENTRY,
        permissions: [
          "news:read",
          "calendar:read",
          "bookings:readAvailability",
        ],
        personalData: ["freeText"],
        actions: [],
      },
    });

    expect(
      screen.getByText(
        "Läsa de nyheter som styrelsen har publicerat, både det som är för medlemmarna och det som är för alla. Texten kan nämna personer",
      ),
    ).toBeTruthy();
    expect(
      screen.getByText(
        "Läsa publicerade evenemang och kallelser till föreningsstämmor som ännu inte har hållits, både det som är för medlemmarna och det som är för alla. Texten kan nämna personer",
      ),
    ).toBeTruthy();
    expect(
      screen.getByText(
        "Se de bokningsbara resurserna och när var och en är upptagen, men inte vem som har bokat",
      ),
    ).toBeTruthy();

    expect(container.textContent).not.toContain("news:read");
    expect(container.textContent).not.toContain("calendar:read");
    expect(container.textContent).not.toContain("bookings:readAvailability");
  });

  it("states the picture and address reads as sentences, never as their codes", () => {
    // The picture sentence says which pictures, because the rule is what the
    // board consents to: nothing of people. The address sentence says that it
    // stops at the door.
    const { container } = renderPanel({
      entry: {
        ...ENTRY,
        permissions: ["media:read", "addresses:read"],
        personalData: ["photograph"],
        actions: [],
      },
    });

    expect(
      screen.getByText(
        "Läsa föreningens bilder som är för medlemmarna eller för alla, och bara de som är märkta att inte visa någon som går att känna igen",
      ),
    ).toBeTruthy();
    expect(
      screen.getByText("Se föreningens adresser, men inte vem som bor där"),
    ).toBeTruthy();

    expect(container.textContent).not.toContain("media:read");
    expect(container.textContent).not.toContain("addresses:read");
  });

  it("states each personal data category as a sentence, never as its code", () => {
    const { container } = renderPanel();

    expect(screen.getByText("Namn")).toBeTruthy();
    expect(screen.getByText("Lägenhet och adress")).toBeTruthy();
    expect(screen.getByText("E-postadress")).toBeTruthy();

    expect(container.textContent).not.toContain("apartment");
  });

  it("states the categories a plugin handles through the actions it calls", () => {
    /*
     * An assistant passing issue reports and minutes to a model provider
     * handles what people wrote, and a board consenting to it has to read that
     * here rather than find it in the record of processing activities later.
     */
    const { container } = renderPanel({
      entry: {
        ...ENTRY,
        personalData: ["name", "freeText", "financial", "health"],
      },
    });

    expect(
      screen.getByText(
        "Text som personer har skrivit själva, till exempel felanmälningar, inlägg och protokoll, och som kan nämna vem som helst",
      ),
    ).toBeTruthy();
    expect(
      screen.getByText(
        "Avgifter och betalningar: vad en person är skyldig eller har betalat",
      ),
    ).toBeTruthy();
    expect(
      screen.getByText(
        "Uppgifter om hälsa, en känslig kategori av personuppgifter, där någon har skrivit dem",
      ),
    ).toBeTruthy();

    expect(container.textContent).not.toContain("freeText");
    expect(container.textContent).not.toContain("inte känner igen");
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

  it("says that devices reach the routes it declares, with nobody signed in", () => {
    /*
     * A device route answers a token the board issues and no person (ADR
     * 0031), so a board consenting to the plugin is consenting to addresses a
     * screen in the stairwell reads. The screen says so before the
     * acknowledgement, and names the addresses.
     */
    renderPanel({
      entry: { ...ENTRY, deviceRoutes: [{ id: "screen", path: "screen" }] },
    });

    expect(
      screen.getByRole("heading", { name: "Nås av enheter" }),
    ).toBeTruthy();
    expect(
      screen.getByText(/som har ett enhetstoken som styrelsen utfärdar/),
    ).toBeTruthy();
    expect(screen.getByText("Adresser: screen")).toBeTruthy();
  });

  it("says nothing about devices when the plugin declares no device route", () => {
    renderPanel();

    expect(
      screen.queryByRole("heading", { name: "Nås av enheter" }),
    ).toBeNull();
  });

  it("lists what residents can do without a board seat, each title opening to its address", async () => {
    /*
     * A resident route lowers the floor of a plugin that reads the register
     * for every resident the address book lists to it (ADR 0051), so the
     * board reads who can use it, what for, and what the plugin can and
     * cannot do there before it consents.
     */
    const user = userEvent.setup();
    renderPanel({
      entry: {
        ...ENTRY,
        id: "parking-share",
        permissions: ["addressBook:read"],
        residentRoutes: [
          {
            path: "offers",
            title: {
              sv: "Erbjuda sin parkeringsplats några dagar",
              en: "Offer your parking space for some days",
            },
          },
        ],
      },
    });

    expect(
      screen.getByRole("heading", { name: "Boende kan använda tillägget" }),
    ).toBeTruthy();
    expect(screen.getByText(/utan plats i styrelsen/)).toBeTruthy();
    expect(screen.getByText(/Där kan det inte läsa registret\./)).toBeTruthy();
    const title = screen.getByText("Erbjuda sin parkeringsplats några dagar");
    const address = screen.getByText("/api/plugin/parking-share/offers");
    expect(address.closest("details")?.open).toBe(false);

    await user.click(title);

    expect(address.closest("details")?.open).toBe(true);
  });

  it("says nothing about residents when the plugin declares no resident route", () => {
    renderPanel();

    expect(
      screen.queryByRole("heading", { name: "Boende kan använda tillägget" }),
    ).toBeNull();
  });

  it("says what being an AI package amounts to", () => {
    /*
     * A declaration about what the plugin is rather than what it may touch. A
     * board reading the lists above cannot tell that a language model chooses
     * what this plugin does, that it reaches only what is offered to the AI
     * package, or that the audit log will name its writes that way - so the
     * screen says all three before the acknowledgement.
     */
    renderPanel({ entry: { ...ENTRY, ai: true } });

    expect(screen.getByRole("heading", { name: "Ett AI-paket" })).toBeTruthy();
    expect(
      screen.getByText(
        "En språkmodell väljer vad tillägget gör, och agerar som den person som bad om det.",
      ),
    ).toBeTruthy();
    expect(
      screen.getByText(
        "Det kan bara göra det som erbjuds AI-paketet, och ett tilläggs åtgärd först när en administratör har aktiverat den.",
      ),
    ).toBeTruthy();
    expect(
      screen.getByText(
        "Det som ändras förs in i granskningsloggen som gjort via AI-paketet.",
      ),
    ).toBeTruthy();
  });

  it("says nothing about an AI package when the plugin is none", () => {
    // Absent rather than empty, like the sign-in address.
    renderPanel();

    expect(screen.queryByRole("heading", { name: "Ett AI-paket" })).toBeNull();
  });

  const LICENCE = {
    entitlement: "mcp-connector",
    issuer: { name: "Exempel AB", url: "https://licence.example.org" },
    keys: { "example-2026-1": `${"A".repeat(42)}A=` },
    audiences: ["https://gateway.example.org", "https://themes.example.org"],
  };

  it("says that a paid plugin needs a licence, and names each service it may show it to", () => {
    // ADR 0042: the audiences are a grant, so the board reads each by name
    // before it consents, as it reads the permissions.
    renderPanel({
      entry: { ...ENTRY, licence: LICENCE, released: "2026-12-01" },
    });

    expect(screen.getByRole("heading", { name: "En licens" })).toBeTruthy();
    expect(
      screen.getByText(
        "Tillägget behöver en licens för mcp-connector från Exempel AB och gör ingenting utan en. Licensen läggs in på licenssidan.",
      ),
    ).toBeTruthy();
    for (const audience of LICENCE.audiences) {
      expect(
        screen.getByText(
          `Det får visa föreningens licens för mcp-connector för Exempel AB på ${audience}, så att tjänsten där vet att licensen finns.`,
        ),
      ).toBeTruthy();
    }
    // Nothing about coverage where the licence held covers the release.
    expect(screen.queryByText(/vilande/)).toBeNull();
  });

  it("says before an update that the licence held does not cover the release", () => {
    renderPanel({
      entry: {
        ...ENTRY,
        installedVersion: "1.1.0",
        licence: LICENCE,
        released: "2026-12-01",
        releaseNotCovered: { updatesUntil: "2026-11-30" },
      },
    });

    expect(
      screen.getByText(
        "Licensen som finns täcker versioner som släppts till och med 2026-11-30, och den här versionen är från 2026-12-01. Efter uppdateringen är tillägget vilande tills en licens som täcker den läggs in.",
      ),
    ).toBeTruthy();
  });

  it("says nothing about a licence when the plugin reads none", () => {
    renderPanel();

    expect(screen.queryByRole("heading", { name: "En licens" })).toBeNull();
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

/**
 * Plugins that extend plugins (ADR 0030). Each half of a flow of personal data
 * between two plugins is on the screen of the plugin it belongs to, named in
 * the board's words and before anything is downloaded.
 */
describe("extension points and what an addon extends", () => {
  const SOURCE = {
    id: "source",
    version: 1,
    personalData: ["name" as const, "apartment" as const],
    title: { sv: "Källa", en: "Source" },
    description: {
      sv: "Något som visas i skärmens växling.",
      en: "Something the screen's rotation shows.",
    },
  };
  const EXTENDS = {
    plugin: "signage",
    point: "source",
    version: 1,
    personalData: ["name" as const, "apartment" as const],
    pluginName: { sv: "Digital skyltning", en: "Digital signage" },
    pointTitle: { sv: "Källa", en: "Source" },
  };

  it("says what a host plugin's points accept", () => {
    renderPanel({ entry: { ...ENTRY, extensionPoints: [SOURCE] } });

    expect(
      screen.getByRole("heading", { name: "Andra tillägg kan bidra till det" }),
    ).toBeTruthy();
    expect(
      screen.getByText(
        /^Källa: Något som visas i skärmens växling\. Tar emot Namn/,
      ),
    ).toBeTruthy();
  });

  it("says what an addon extends and what it hands over, by name", () => {
    renderPanel({ entry: { ...ENTRY, extends: [EXTENDS] } });

    const line = screen.getByText(/^Digital skyltning vid Källa/);
    expect(line.textContent).toContain("och lämnar");
    expect(line.textContent).not.toContain("signage");
    // And that no plugin gets any other plugin's permissions.
    expect(
      screen.getByText(/Inget tillägg får något annat tilläggs behörigheter/),
    ).toBeTruthy();
  });

  it("says when an addon hands over no personal data", () => {
    renderPanel({
      entry: { ...ENTRY, extends: [{ ...EXTENDS, personalData: [] }] },
    });

    expect(
      screen.getByText(
        "Digital skyltning vid Källa, och lämnar inga personuppgifter till det.",
      ),
    ).toBeTruthy();
  });

  it("names the plugin by its id where the catalog does not list it", () => {
    renderPanel({
      entry: {
        ...ENTRY,
        extends: [{ ...EXTENDS, pluginName: null, pointTitle: null }],
      },
    });

    expect(screen.getByText(/^signage vid source/)).toBeTruthy();
  });

  it("names the installed plugins the install holds to the board (ADR 0052)", () => {
    renderPanel({
      entry: {
        ...ENTRY,
        extends: [EXTENDS],
        holdsToBoard: [
          {
            id: "signage",
            name: { sv: "Digital skyltning", en: "Digital signage" },
          },
          { id: "signage-weather", name: null },
        ],
      },
    });

    const sentence = screen.getByText(
      /vägar hos Digital skyltning, signage-weather som kräver ett inloggat konto bara styrelsen och administratören,/,
    );
    expect(sentence.textContent).toContain("förbinder dem med");
    expect(sentence.textContent).toContain("adressboken eller ekonomin");
    // A receipt-only addon reads neither: the sentence says what it does do.
    expect(sentence.textContent).toContain(
      "registrerar en leverans mot en avi eller en debitering",
    );
  });

  it("words it for one plugin", () => {
    renderPanel({
      entry: {
        ...ENTRY,
        extends: [EXTENDS],
        holdsToBoard: [
          {
            id: "signage",
            name: { sv: "Digital skyltning", en: "Digital signage" },
          },
        ],
      },
    });

    expect(
      screen.getByText(
        /vägar hos Digital skyltning som kräver ett inloggat konto bara styrelsen och administratören, eftersom/,
      ).textContent,
    ).toContain("förbinder det med");
  });

  it("says nothing about the board where the install raises no plugin", () => {
    renderPanel({ entry: { ...ENTRY, extends: [EXTENDS] } });

    expect(
      screen.queryByText(
        /som kräver ett inloggat konto bara styrelsen och administratören/,
      ),
    ).toBeNull();
  });

  it("says nothing about extensions for a plugin that raises neither", () => {
    renderPanel();

    expect(screen.queryByRole("heading", { name: "Det utökar" })).toBeNull();
    expect(
      screen.queryByRole("heading", {
        name: "Andra tillägg kan bidra till det",
      }),
    ).toBeNull();
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
        name: "Skickar tillägget personuppgifter utanför instansen, eller tar det emot dem utifrån?",
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

  it("puts the warning directly under the field that holds one and links the field to it", async () => {
    /*
     * A status region inserted together with its message can stay silent, so
     * each field has its region from the moment it is shown, empty, and only
     * its content comes and goes. The field holding the number is invalid and
     * described by the warning under it, so the warning is neither ~300px away
     * nor left to a screen-reader user to find.
     */
    const session = userEvent.setup();
    renderPanel();

    await session.click(somethingLeaves());
    const recipientRegion = recipientField().parentElement?.nextElementSibling;
    expect(recipientRegion?.getAttribute("role")).toBe("status");
    expect(recipientRegion?.getAttribute("aria-live")).toBe("polite");
    expect(recipientRegion?.textContent).toBe("");
    expect(recipientField().getAttribute("aria-invalid")).toBeNull();

    await session.type(recipientField(), "Anna 811228-9874");
    expect(recipientField().getAttribute("aria-invalid")).toBe("true");
    expect(recipientRegion?.textContent).toContain("Skriv utan personnummer.");
    // Under the field, not at the foot of the step; the hint follows it.
    expect(recipientRegion?.previousElementSibling).toBe(
      recipientField().parentElement,
    );
    const described = (recipientField().getAttribute("aria-describedby") ?? "")
      .split(" ")
      .map((id) => document.getElementById(id));
    expect(described).toContain(recipientRegion);
    expect(described.length).toBe(2);

    await session.clear(recipientField());
    await session.type(recipientField(), "Kartbolaget AB");
    expect(recipientField().getAttribute("aria-invalid")).toBeNull();
    expect(recipientRegion?.textContent).toBe("");
    expect(
      document.getElementById(
        recipientField().getAttribute("aria-describedby") ?? "",
      )?.textContent,
    ).toContain("Företaget eller tjänsten");

    await session.click(asIndependentController());
    const note = screen.getByRole("textbox", {
      name: "Varför inget avtal behövs",
    });
    const noteRegion = note.parentElement?.nextElementSibling;
    expect(noteRegion?.getAttribute("role")).toBe("status");
    expect(noteRegion?.textContent).toBe("");
    await session.type(note, "Enligt 811228-9874");
    expect(note.getAttribute("aria-invalid")).toBe("true");
    expect(
      document.getElementById(note.getAttribute("aria-describedby") ?? ""),
    ).toBe(noteRegion);
    expect(noteRegion?.textContent).toContain("Skriv utan personnummer.");
    // Only the field that holds it.
    expect(recipientField().getAttribute("aria-invalid")).toBeNull();
    expect(recipientRegion?.textContent).toBe("");
    expect(installButton()).toHaveProperty("disabled", true);
  });
});

/**
 * Where the plugin declares it connects to (ADR 0037): shown before the
 * question, and filling in the half of it a declaration can answer.
 */
describe("the recipients a plugin declares", () => {
  const provider = {
    id: "model-provider",
    origin: "https://api.anthropic.com",
    purpose: {
      sv: "Skickar texten styrelsen ber om hjälp med till språkmodellen.",
      en: "Sends the text the board asks for help with to the language model.",
    },
    personalData: ["name" as const],
  };
  const rates = {
    id: "rates",
    origin: "https://rates.example.test:8443",
    purpose: { sv: "Hämtar dagens räntor.", en: "Fetches the day's rates." },
    personalData: [],
  };

  it("are each stated with the host, the purpose in the board's language and what it receives", () => {
    renderPanel({ entry: { ...ENTRY, recipients: [provider, rates] } });

    expect(
      screen.getByRole("heading", { name: "Vart det ansluter" }),
    ).toBeTruthy();
    // The category in the board's words, never as its code.
    expect(
      screen.getByText(
        "api.anthropic.com - Skickar texten styrelsen ber om hjälp med till språkmodellen. - Namn",
      ),
    ).toBeTruthy();
    expect(
      screen.getByText(
        "rates.example.test:8443 - Hämtar dagens räntor. - inga personuppgifter",
      ),
    ).toBeTruthy();
    // What it is: the plugin's own word, held by the catalog's review.
    expect(screen.getByText(/tilläggets egen uppgift/)).toBeTruthy();
  });

  it("are not mentioned for a plugin that declares none", () => {
    renderPanel();

    expect(
      screen.queryByRole("heading", { name: "Vart det ansluter" }),
    ).toBeNull();
  });

  // "Yes" and the host are what the declaration says; which kind of recipient
  // it is stays the board's call, so the install button stays shut until the
  // board makes it.
  it("fill in yes and the recipient, and leave the classification to the board", async () => {
    const onConfirm = vi.fn();
    const session = userEvent.setup();
    renderPanel({
      entry: { ...ENTRY, recipients: [provider, rates] },
      onConfirm,
    });

    expect(somethingLeaves()).toHaveProperty("checked", true);
    expect(recipientField()).toHaveProperty("value", "api.anthropic.com");
    expect(asProcessor()).toHaveProperty("checked", false);
    expect(asIndependentController()).toHaveProperty("checked", false);

    await session.click(acknowledgement());
    expect(installButton()).toHaveProperty("disabled", true);

    await session.click(asProcessor());
    await session.click(installButton());
    expect(onConfirm).toHaveBeenCalledWith({
      sendsPersonalDataOutside: true,
      recipient: "api.anthropic.com",
      classification: "PROCESSOR",
    });
  });

  // A "no" on the plugin's word alone would record that nothing leaves the
  // instance on the strength of a click.
  it("choose nothing where no declared recipient receives personal data", () => {
    renderPanel({ entry: { ...ENTRY, recipients: [rates] } });

    expect(nothingLeaves()).toHaveProperty("checked", false);
    expect(somethingLeaves()).toHaveProperty("checked", false);
    // And the introduction says so, rather than that the answer is filled in.
    expect(screen.getByText(/svaret är ert att ge/)).toBeTruthy();
    expect(screen.queryByText(/Svaret är ifyllt/)).toBeNull();
  });

  // Eight ordinary hosts are an answer longer than one name; the field holds
  // all of it, and it travels as filled in.
  it("fill in and send every host of the longest declaration", async () => {
    const onConfirm = vi.fn();
    const session = userEvent.setup();
    const recipients = Array.from({ length: 8 }, (_, index) => ({
      ...provider,
      id: `provider-${String(index)}`,
      origin: `https://model-inference-provider-${String(index)}.example.com`,
    }));
    const hosts = recipients
      .map((recipient) => recipient.origin.slice("https://".length))
      .join(", ");
    renderPanel({ entry: { ...ENTRY, recipients }, onConfirm });

    expect(recipientField()).toHaveProperty("value", hosts);
    expect(
      (recipientField() as HTMLInputElement).maxLength,
    ).toBeGreaterThanOrEqual(hosts.length);

    await session.click(acknowledgement());
    await session.click(asProcessor());
    await session.click(installButton());
    expect(onConfirm).toHaveBeenCalledWith(
      expect.objectContaining({ recipient: hosts }),
    );
  });

  it("say the answer is filled in only where it is", () => {
    renderPanel({ entry: { ...ENTRY, recipients: [provider, rates] } });

    expect(screen.getByText(/Svaret är ifyllt/)).toBeTruthy();
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

/** ADR 0035: what the install writes into the record of processing activities. */
describe("the processing the plugin declares", () => {
  it("states the purpose, the basis with the interest, the retention and whose data", () => {
    renderPanel();

    expect(
      screen.getByText("Ändamål: Skicka grannsamverkansbrev till de boende."),
    ).toBeTruthy();
    expect(
      screen.getByText(
        "Rättslig grund: berättigat intresse (art. 6.1 f). Intresset: Att grannarna kan hålla uppsikt över huset.",
      ),
    ).toBeTruthy();
    expect(
      screen.getByText("Sparas: Adresserna sparas inte efter utskicket."),
    ).toBeTruthy();
    expect(screen.getByText("Vems uppgifter: medlemmar, boende")).toBeTruthy();
  });

  it("names a basis other than legitimate interest without an interest", () => {
    renderPanel({
      entry: {
        ...ENTRY,
        processing: {
          purpose: { sv: "Avtalet.", en: "The contract." },
          legalBasis: "contract",
          retention: { sv: "Ett år.", en: "One year." },
          dataSubjects: ["members"],
        },
      },
    });

    expect(
      screen.getByText("Rättslig grund: medlemsavtalet (art. 6.1 b)"),
    ).toBeTruthy();
  });

  it("says when a plugin with personal data declares nothing, and shows nothing for one without", () => {
    const { unmount } = renderPanel({ entry: { ...ENTRY, processing: null } });
    expect(
      screen.getByText(/Tillägget anger inte vad behandlingen är till för/),
    ).toBeTruthy();
    unmount();

    renderPanel({
      entry: { ...ENTRY, personalData: [], processing: null },
    });
    expect(screen.queryByText("Vad behandlingen är till för")).toBeNull();
  });

  it("says on an update that the board's own wording is kept", () => {
    renderPanel({ entry: { ...ENTRY, installedVersion: "1.1.0" } });

    expect(screen.getByText(/behålls styrelsens formulering/)).toBeTruthy();
  });
});

/** ADR 0047: what the plugin keeps about a person, before the download. */
describe("the records about a person the plugin keeps", () => {
  const CLAIMS = {
    collection: "claims",
    titleKey: "records.claims.title",
    personalData: ["apartment" as const],
    keepAtMostDays: 730,
    fields: [],
  };

  it("names each collection with what it holds and how long, and what the host does with it", () => {
    renderPanel({ entry: { ...ENTRY, personRecords: [CLAIMS] } });

    expect(screen.getByText("Uppgifter det sparar om en person")).toBeTruthy();
    expect(
      screen.getByText(/^claims: .+\. Varje uppgift sparas högst 730 dagar\.$/),
    ).toBeTruthy();
    expect(screen.getByText(/Open BRF raderar den på sitt datum/)).toBeTruthy();
  });

  it("says nothing about them for a plugin that keeps none", () => {
    renderPanel();

    expect(screen.queryByText("Uppgifter det sparar om en person")).toBeNull();
  });
});

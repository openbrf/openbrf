import {
  ADDRESSES,
  ADMINISTRATOR,
  HOUSING_COOPERATIVE,
} from "../src/provision";

/**
 * Every screen the capture writes an image of, in the order it walks them.
 *
 * This file is data. A branch that builds a screen adds it here, in the same
 * pull request, and writes no Playwright code: see e2e/README.md for the
 * contract and for the screens still waiting on the branches that build them.
 *
 * The order matters. An instance is unclaimed exactly once, so the setup wizard
 * has to come first, and each entry starts from the state the entry before it
 * left behind. That is why `prepare` is "how to get here from the screen
 * above", not "how to get here from nothing": the wizard keeps its step in React
 * state, which a reload would throw away.
 */

/** Who is signed in. Omitted means "carry on as whoever the last screen left". */
export type Actor = "nobody" | "administrator" | "resident";

/**
 * How to find something on the screen.
 *
 * A string matches exactly, except for the two that name a form field -
 * `label` and `combobox` - where it matches from the beginning, because a
 * field's `<label>` wraps its hint as well as its word. A regular expression
 * always matches as written.
 *
 * There are no test ids in the client, deliberately, so everything here is the
 * name a person reads or hears - which also means an entry stops working when
 * the screen stops being usable, rather than when a class name changes.
 */
type Where =
  | { readonly heading: string | RegExp }
  | { readonly button: string | RegExp }
  | { readonly combobox: string | RegExp }
  | { readonly label: string | RegExp }
  | { readonly text: string | RegExp }
  /** The settings card whose level-2 heading reads exactly this. */
  | { readonly panel: string };

export type Target = Where & {
  /**
   * Take the first match instead of insisting there is only one.
   *
   * A register row carries the same control as every other row - "open
   * apartment 1001" appears once per person living in it - so this says "the
   * one at the top" rather than leaving the entry to fail on the ambiguity.
   */
  readonly first?: true;
};

/** One step towards a screen no URL can express. */
export type Action =
  | { readonly click: Target }
  | { readonly fill: Target; readonly value: string }
  | { readonly select: Target; readonly option: string }
  /** Wait for something to appear before going on. */
  | { readonly see: Target };

export type Screen = {
  /** File stem. The images are <name>-light.png and <name>-dark.png. */
  readonly name: string;
  /** Establish this session first. Omit to continue in the current one. */
  readonly as?: Actor;
  /** Go here first. Omit to stay on the screen the entry above reached. */
  readonly goto?: string;
  /** Clicks and fills that reach the state this screen is about. */
  readonly prepare?: readonly Action[];
  /**
   * Proves the right screen rendered. The capture waits for it.
   *
   * Something that exists only once the screen's data does - a row, a name, a
   * value - rather than a static heading. A heading is rendered before the
   * request that fills the page comes back, so waiting for one photographs a
   * screen mid-load, and the rows arriving next land in the picture. The check
   * that runs after the picture is taken is what stops those rows reaching a
   * published image; a marker that waits for the data is what stops the image
   * being of a page that had not finished.
   */
  readonly waitFor: Target;
  /**
   * What to photograph. "viewport" is the default, "page" scrolls the whole
   * document, and a target photographs that one element.
   */
  readonly capture?: "viewport" | "page" | Target;
};

const [STORGATAN_12, STORGATAN_14] = ADDRESSES;

/** Every settings card, by the heading a reader sees on it. */
const SETTINGS_PANELS = [
  ["settings-housing-cooperative", "Föreningen"],
  ["settings-addresses", "Adresser"],
  ["settings-apartments", "Lägenheter"],
  ["settings-email", "E-post"],
  ["settings-appearance", "Utseende"],
  ["settings-retention", "Gallring"],
  ["settings-self-signup", "Ansökningar om konto"],
  ["settings-profile", "Din profil"],
] as const;

export const SCREENS: readonly Screen[] = [
  // --- the setup wizard ------------------------------------------------------
  // Seven screens on one URL: the wizard keeps its step in React state, so each
  // entry below drives the one above it forward rather than navigating.
  {
    name: "setup-administrator",
    as: "nobody",
    goto: "/setup",
    prepare: [
      { fill: { label: "Förnamn" }, value: ADMINISTRATOR.firstName },
      { fill: { label: "Efternamn" }, value: ADMINISTRATOR.lastName },
      { fill: { label: "E-postadress" }, value: ADMINISTRATOR.email },
      { fill: { label: "Lösenord" }, value: ADMINISTRATOR.password },
    ],
    waitFor: { heading: "Kom i gång med Open BRF" },
  },
  {
    name: "setup-housing-cooperative",
    prepare: [
      { click: { button: "Skapa kontot" } },
      { see: { heading: "Föreningen" } },
      { fill: { label: "Namn" }, value: HOUSING_COOPERATIVE.name },
      {
        fill: { label: "Organisationsnummer" },
        value: HOUSING_COOPERATIVE.organizationNumber,
      },
    ],
    waitFor: { heading: "Föreningen" },
  },
  {
    name: "setup-addresses",
    prepare: [
      { click: { button: "Fortsätt" } },
      { see: { heading: "Adresser" } },
      { fill: { label: "Gata" }, value: STORGATAN_12.street },
      { fill: { label: "Nummer" }, value: STORGATAN_12.number },
      { fill: { label: "Postnummer" }, value: STORGATAN_12.postalCode },
      { fill: { label: "Ort" }, value: STORGATAN_12.city },
      { click: { button: "Lägg till adress" } },
      {
        see: {
          button: `Ta bort ${STORGATAN_12.street} ${STORGATAN_12.number}`,
        },
      },
      { fill: { label: "Gata" }, value: STORGATAN_14.street },
      { fill: { label: "Nummer" }, value: STORGATAN_14.number },
      { fill: { label: "Postnummer" }, value: STORGATAN_14.postalCode },
      { fill: { label: "Ort" }, value: STORGATAN_14.city },
      { click: { button: "Lägg till adress" } },
      {
        see: {
          button: `Ta bort ${STORGATAN_14.street} ${STORGATAN_14.number}`,
        },
      },
    ],
    waitFor: { heading: "Adresser" },
  },
  {
    name: "setup-apartments",
    prepare: [
      { click: { button: "Fortsätt" } },
      { see: { heading: "Lägenheter" } },
      // By role rather than by label: the label wraps the select, so its text
      // carries every option's text as well.
      {
        select: { combobox: "Adress" },
        option: `${STORGATAN_12.street} ${STORGATAN_12.number}`,
      },
      { fill: { label: "Lägsta våning" }, value: "0" },
      { fill: { label: "Antal våningar" }, value: String(STORGATAN_12.floors) },
      {
        fill: { label: "Lägenheter per våning" },
        value: String(STORGATAN_12.perFloor),
      },
      // Photographed with the generated list on screen, which is the state the
      // step exists to show.
      { click: { button: "Generera" } },
    ],
    waitFor: { heading: "Lägenheter" },
  },
  {
    name: "setup-email",
    prepare: [
      { click: { button: "Spara lägenheterna" } },
      // Saved before moving on, so the click below is not racing the write.
      {
        see: {
          text: new RegExp(
            `^Lade till ${String(STORGATAN_12.floors * STORGATAN_12.perFloor)}`,
          ),
        },
      },
      { click: { button: "Fortsätt" } },
      { see: { heading: "E-post" } },
      { fill: { label: "Server" }, value: "mailpit" },
      { fill: { label: "Port" }, value: "1025" },
      { fill: { label: "Avsändaradress" }, value: "noreply@eksemplet.test" },
    ],
    waitFor: { heading: "E-post" },
  },
  {
    name: "setup-appearance",
    prepare: [
      { click: { button: "Spara" } },
      { see: { text: /E-post är inställt/ } },
      { click: { button: "Fortsätt" } },
      { see: { heading: "Utseende" } },
      { fill: { label: "Primärfärg" }, value: "#7D5F23" },
    ],
    waitFor: { heading: "Utseende" },
  },
  {
    name: "setup-done",
    prepare: [
      { click: { button: "Spara" } },
      { click: { button: "Fortsätt" } },
    ],
    waitFor: { heading: "Föreningen är konfigurerad" },
  },

  // --- signed out ------------------------------------------------------------
  {
    name: "sign-in",
    as: "nobody",
    goto: "/sign-in",
    waitFor: { button: "Logga in med en nyckel" },
  },

  // --- the address book ------------------------------------------------------
  {
    name: "address-book-board",
    as: "administrator",
    goto: "/",
    waitFor: { heading: "Adressbok" },
  },
  {
    name: "address-book-person",
    prepare: [{ click: { button: "Öppna Astrid Lindqvist" } }],
    waitFor: { heading: "Astrid Lindqvist" },
  },
  {
    name: "address-book-apartment",
    prepare: [
      { click: { button: "Stäng" } },
      // Two people live in 1001 on Storgatan 12 and a third in 1001 on
      // Storgatan 14, and each row carries the same control, so this asks for
      // the one at the top of the board rather than for the only one.
      { click: { button: "Öppna lägenhet 1001", first: true } },
    ],
    // The number sits in a span of its own inside the heading, so this is
    // matched rather than compared.
    waitFor: { heading: /^Lägenhet\s+1001$/ },
  },

  // --- settings --------------------------------------------------------------
  // One route, one card per setting. The whole page first, then each card on
  // its own, so a pull request that changes one of them can show that one.
  {
    name: "settings",
    goto: "/settings",
    waitFor: { heading: "Inställningar" },
    capture: "page",
  },
  ...SETTINGS_PANELS.map(([name, title]): Screen => ({
    name,
    waitFor: { panel: title },
    capture: { panel: title },
  })),

  // --- the resident-facing board ---------------------------------------------
  // Last, because it is the one screen that needs a second session: the server
  // refuses the board view to anyone without the capability, so this is a
  // resident signing in rather than a flag being turned over.
  {
    name: "address-book-resident",
    as: "resident",
    goto: "/",
    waitFor: { heading: "Adressbok" },
  },
];

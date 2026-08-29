import {
  ADDRESSES,
  ADMINISTRATOR,
  HOUSING_COOPERATIVE,
} from "../src/provision";
import { appPath } from "../src/stack";
import { APPLICANT, MEMBER, MEMBER_LIST } from "./people";

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

/**
 * Who is signed in. Omitted means "carry on as whoever the last screen left".
 *
 * The two residents are separate because the product tells them apart: a
 * tenant-owner reads their own entry in the apartment register, and somebody
 * who lives in an apartment without holding it has no entry to read.
 */
export type Actor = "nobody" | "administrator" | "resident" | "member";

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

/**
 * A file handed to an upload control.
 *
 * Written out here rather than read from disk: the manifest is data, and a
 * fixture nobody can read in a diff is a fixture nobody checks against the
 * publishing rules.
 */
export interface UploadedFile {
  /** The name the screen shows and the parser reports back. */
  readonly name: string;
  readonly mimeType: string;
  /** The whole file, as text. */
  readonly text: string;
}

/** One step towards a screen no URL can express. */
export type Action =
  | { readonly click: Target }
  | { readonly fill: Target; readonly value: string }
  | { readonly select: Target; readonly option: string }
  | { readonly upload: Target; readonly file: UploadedFile }
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
  ["settings-signup-queue", "Väntande ansökningar"],
  ["settings-profile", "Din profil"],
] as const;

/**
 * A token in the shape an invitation link carries.
 *
 * The activation screen renders its form from the link alone and sends the
 * token only when the form is submitted, so a made-up one photographs the
 * screen without consuming somebody's invitation. The walk never submits it.
 */
const ACTIVATION_LINK_TOKEN = "aktiveringslank-utan-inbjudan";

export const SCREENS: readonly Screen[] = [
  // --- the setup wizard ------------------------------------------------------
  // Seven screens on one URL: the wizard keeps its step in React state, so each
  // entry below drives the one above it forward rather than navigating.
  {
    name: "setup-administrator",
    as: "nobody",
    goto: appPath("/setup"),
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
    goto: appPath("/sign-in"),
    waitFor: { button: "Logga in med en nyckel" },
  },

  // --- the address book ------------------------------------------------------
  {
    name: "address-book-board",
    as: "administrator",
    goto: appPath(),
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
  {
    // Everybody the register fixture seeds is invited when the board approves
    // their request, so the account field on a person view is in this state
    // until somebody chooses a password.
    name: "person-invitation",
    prepare: [
      { click: { button: "Stäng" } },
      { click: { button: "Öppna Nils Lindqvist" } },
    ],
    waitFor: { text: "Inbjuden, inte aktiverat" },
  },

  // --- the statutory registers -----------------------------------------------
  // Two documents on two routes, because the law separates them: the member
  // register is public on request and carries no personal identity number, the
  // apartment register is confidential and masks the ones it holds.
  {
    name: "member-register",
    goto: appPath("/registers/members"),
    waitFor: { text: MEMBER.name },
    capture: "page",
  },
  {
    name: "apartment-register",
    goto: appPath("/registers/apartments"),
    // The designation of the one apartment somebody holds. Every other
    // apartment in the register renders its own heading, so this names the
    // entry the picture is about.
    waitFor: { heading: MEMBER.designation },
  },

  // --- importing a member list -----------------------------------------------
  // Four steps, of which three are photographed: the file, the columns and the
  // preview. The walk stops before "Genomför importen", so the register the
  // screens above photograph is the register these screens describe changing.
  {
    name: "import-upload",
    goto: appPath("/import"),
    waitFor: { label: "Välj en fil" },
  },
  {
    name: "import-mapping",
    prepare: [
      {
        upload: { label: "Välj en fil" },
        file: {
          name: MEMBER_LIST.fileName,
          mimeType: MEMBER_LIST.mimeType,
          text: MEMBER_LIST.text,
        },
      },
      { click: { button: "Läs filen" } },
    ],
    // One select per column in the file, named after the column it maps: it
    // exists only once the file has been read.
    waitFor: { combobox: "Fält i registret för Förnamn" },
  },
  {
    name: "import-preview",
    prepare: [{ click: { button: "Förhandsgranska importen" } }],
    waitFor: { button: "Genomför importen" },
  },

  // --- composing a theme -----------------------------------------------------
  {
    name: "theme-composer",
    goto: appPath("/admin/themes/compose"),
    // The themes this one may inherit from, which arrive with the installed
    // list rather than with the screen.
    waitFor: { combobox: "Ärver från" },
  },

  // --- signed out again ------------------------------------------------------
  // The screens somebody meets before they have an account, and the
  // association's own website. Signed out on purpose: the request form and the
  // sign-in screen both turn away a visitor who already has a session.
  {
    name: "request-account",
    as: "nobody",
    goto: appPath("/request-account"),
    prepare: [
      { fill: { label: "Förnamn" }, value: APPLICANT.firstName },
      { fill: { label: "Efternamn" }, value: APPLICANT.lastName },
      { fill: { label: "E-postadress" }, value: APPLICANT.email },
      { fill: { label: "Adress" }, value: APPLICANT.claimedAddress },
      {
        fill: { label: "Lägenhetsnummer" },
        value: APPLICANT.claimedApartmentNumber,
      },
    ],
    // The form itself is what the screen shows once it knows the association is
    // accepting requests; a closed instance renders a notice instead.
    waitFor: { button: "Skicka ansökan" },
  },
  {
    // Sent, and left waiting: the board's queue is photographed further down
    // with this request in it.
    name: "request-account-received",
    prepare: [{ click: { button: "Skicka ansökan" } }],
    waitFor: { heading: "Ansökan är mottagen" },
  },
  {
    name: "activate",
    goto: appPath(`/activate?token=${ACTIVATION_LINK_TOKEN}`),
    waitFor: { button: "Aktivera kontot" },
  },
  {
    // The root, which is the association's own website rather than the
    // application: the page the wizard wrote when the instance was claimed.
    name: "site-home",
    goto: "/",
    waitFor: { heading: "Välkommen" },
  },
  {
    name: "site-not-found",
    goto: "/en-sida-som-aldrig-skrivits",
    waitFor: { heading: "Sidan finns inte" },
  },

  // --- settings --------------------------------------------------------------
  // One route, one card per setting. The whole page first, then each card on
  // its own, so a pull request that changes one of them can show that one.
  // After the request above, so the queue card has a request waiting in it.
  {
    name: "settings",
    as: "administrator",
    goto: appPath("/settings"),
    waitFor: { text: APPLICANT.email },
    capture: "page",
  },
  ...SETTINGS_PANELS.map(([name, title]): Screen => ({
    name,
    waitFor: { panel: title },
    capture: { panel: title },
  })),

  // --- the resident-facing board ---------------------------------------------
  // Last, with the tenant-owner below, because these two are the screens that
  // need a session of their own: the server refuses the board view to anyone
  // without the capability and the apartment register to anyone but a holder,
  // so these are residents signing in rather than a flag being turned over.
  {
    name: "address-book-resident",
    as: "resident",
    goto: appPath(),
    waitFor: { heading: "Adressbok" },
  },
  {
    name: "own-apartment-register",
    as: "member",
    goto: appPath("/registers/apartments"),
    waitFor: { heading: MEMBER.designation },
  },

  // --- the association's own website, from the board's side ------------------
  // The administrator again, because writing the website needs site:manage and
  // the two entries above are residents.
  {
    name: "site-admin",
    as: "administrator",
    goto: appPath("/admin/site"),
    // A page in the list rather than the heading: the heading renders before
    // the pages come back.
    waitFor: { button: "Redigera", first: true },
  },
  {
    name: "site-page-editor",
    prepare: [
      { click: { button: "Redigera", first: true } },
      // The text editor is loaded on demand, so the screen is not finished
      // until a paragraph field is on it.
      { see: { label: "Stycke 1" } },
    ],
    waitFor: { button: "Förhandsgranska" },
    capture: "page",
  },
];

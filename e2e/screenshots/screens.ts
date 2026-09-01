import {
  ADDRESSES,
  ADMINISTRATOR,
  HOUSING_COOPERATIVE,
} from "../src/provision";
import { appPath } from "../src/stack";
import { APPLICANT, MEMBER, MEMBER_LIST, RESIDENT } from "./people";

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
  /**
   * Look only inside the settings card whose level-2 heading reads exactly this.
   *
   * The settings screen carries every card on one route, so a name that belongs
   * to a card is not a name that belongs to the screen: seven cards offer a
   * "Spara" and two hold a field whose label begins "Dag". Naming the card is
   * what a person does when they read the screen, and it is the difference
   * between an entry that fills its own field and one that fills a setting in
   * somebody else's card.
   */
  readonly within?: string;
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
 * The motion the general-meeting screens are photographed against.
 *
 * Held here rather than inline because all three entries name it: an
 * administrator records the deadline the bylaws set, a member puts this item to
 * the meeting, and the board reads the same item in its queue.
 */
const MOTION = {
  title: "Laddstolpar i garaget",
  body:
    "Föreningen bör utreda vad det skulle kosta att sätta upp laddstolpar " +
    "för elbilar i garaget, och ta med kostnaden i nästa budget.",
  /** The clause a cooperative's bylaws typically carry: the end of January. */
  deadlineMonth: "1",
  deadlineDay: "31",
} as const;

/**
 * The settings card the deadline is recorded in, named once.
 *
 * Its own name because the entry below states it four times: the card is what
 * the two fields and the save are looked for inside, since every other card on
 * that route offers a save of its own.
 */
const MOTION_DEADLINE_CARD = "Sista dag för motioner";

/**
 * The laundry room the booking screens are photographed against.
 *
 * Held here rather than inline because all three entries name it: the board adds
 * it, a resident books it, and the board reads the hour that was taken. The
 * hours divide into whole slots - 07:00 to 21:00 in seven-hour slots is two a
 * day - because a length that leaves a remainder is refused at save time, and
 * two slots a day is a calendar a reviewer can take in at a glance.
 */
const LAUNDRY = {
  name: "Tvättstugan i port 12",
  description:
    "I källaren i port 12. Städa maskinerna efter dig och töm luddfiltret.",
  slotMinutes: "420",
  opensAt: "07:00",
  closesAt: "21:00",
} as const;

/**
 * A "YYYY-MM-DD" date some whole days from today.
 *
 * Read on the association's clock rather than on this machine's, for the reason
 * the client reads it the same way: just after midnight in Stockholm the two
 * disagree, and the day an event belongs to is the building's. The arithmetic on
 * that date is then calendar arithmetic and carries no zone at all - the day
 * after the 25th of October is the 26th, however many hours that Sunday had.
 *
 * The one computed value in this file, and it is computed because the event
 * screens are about a date somebody can still sign up to: a date written down
 * here would pass into the past, and the walk would photograph a statement
 * saying the date had begun where the control belongs.
 */
function dayFromToday(days: number): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Stockholm",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const field = (type: "year" | "month" | "day"): number =>
    Number(parts.find((part) => part.type === type)?.value);

  const shifted = new Date(
    Date.UTC(field("year"), field("month") - 1, field("day")) +
      days * 24 * 60 * 60 * 1000,
  );
  return shifted.toISOString().slice(0, 10);
}

/**
 * The cleaning day the event screens are photographed against.
 *
 * Held here rather than inline because all three entries name it: the board
 * enters and publishes it, a resident puts their name down for it, and the board
 * reads who is coming. Twice a year with twenty places, because that is what
 * shows the two things this module has that a booking calendar does not - a
 * recurrence rule written out into dates, and places counted per date.
 *
 * A month out, so the date is one somebody can still sign up to whichever day
 * the walk runs on. Six months between the two dates is a monthly rule with an
 * interval of six rather than a frequency of its own: the platform offers weeks,
 * months and years, and the interval is how a board says every other one.
 */
const CLEANING = {
  title: "Städdag",
  category: "Gemensamt arbete",
  location: "Innergården",
  description:
    "Vi räfsar löv, rensar rabatterna och tömmer grovsoprummet. " +
    "Ta med arbetshandskar - föreningen bjuder på fika i föreningslokalen efteråt.",
  firstOn: dayFromToday(30),
  startsAt: "10:00",
  durationMinutes: "180",
  /** Every sixth month, twice, which is spring and autumn. */
  frequency: "Varje månad",
  interval: "6",
  count: "2",
  capacity: "20",
} as const;

/**
 * The notice the news screens are photographed against.
 *
 * Held here rather than inline because six entries name it: the board writes it
 * and publishes it, a resident opens it and answers it, the board strikes that
 * answer through, and the same notice is then read on the association's website
 * where no comment appears at all.
 *
 * The comment carries no personal identity number and no address, like every
 * other value in this file: these images go into pull requests on a public
 * repository, and what a capture can photograph is published.
 */
const NOTICE = {
  title: "Städdag i trapphuset",
  slug: "staddag-i-trapphuset",
  /** The first sentence, which the article page is waited for by. */
  opening: "Vi städar trapphuset lördagen den 12 oktober klockan tio.",
  /** What a resident leaves under it. */
  comment: "Tack för beskedet. Jag tar med en hink och krattan.",
} as const;

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
  {
    /*
     * The board's inbox for the website's contact form, empty.
     *
     * Empty because nothing in this walk can put a message in it: the form
     * lives on a page of the association's own, placed there by the board, and
     * the wizard seeds no page that carries one. The empty state is the honest
     * picture of this card on a fresh instance, and it is the one a board sees
     * before anybody has written to them.
     *
     * Its own entry rather than a row in SETTINGS_PANELS above, because the
     * marker has to be something that exists only once the card's own read has
     * come back - and for an empty inbox that is the sentence saying so.
     */
    name: "settings-contact-inbox",
    waitFor: { text: "Inga meddelanden har kommit in." },
    capture: { panel: "Meddelanden från webbplatsen" },
  },

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

  // --- retention -------------------------------------------------------------
  // Last, because both of them write: the hold stays on the person for the rest
  // of the walk, and the report is the only screen that decrypts everything
  // about somebody. Neither is reached from the navigation - a legal hold and an
  // access report are things the board does to one named person, so they live on
  // that person's view.
  {
    // The purge suspended for one person, with the reason on screen. The
    // sentence above the button is what a board reads instead of inferring the
    // state from a date that has stopped applying.
    name: "person-legal-hold",
    as: "administrator",
    goto: appPath(),
    prepare: [
      { click: { button: "Öppna Astrid Lindqvist" } },
      { see: { heading: "Astrid Lindqvist" } },
      {
        fill: { label: "Varför uppgifterna bevaras" },
        value: "Tvist om andrahandsuthyrning, Hyresnämnden 2026-0421",
      },
      { click: { button: "Inför ett rättsligt bevarandekrav" } },
    ],
    // The release button exists only once the panel has read the standing hold
    // back, so waiting for it waits for the write rather than for the click.
    waitFor: { button: "Häv det rättsliga bevarandekravet" },
  },
  {
    // The whole document, scrolled: it is printed and handed over, so the
    // picture has to show what comes out of the printer rather than the top of
    // it. Astrid holds no personal identity number, which the safety check
    // would refuse an image of in any case.
    name: "data-subject-report",
    prepare: [{ click: { button: "Ta fram registerutdraget" } }],
    // A section heading the document renders only once the report has arrived.
    waitFor: { heading: "Medlemsförteckningen" },
    capture: "page",
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

  // --- news ------------------------------------------------------------------
  // The board's own screen, then the item it published, then a resident reading
  // that item and answering it, then the board striking the answer through, then
  // the item on the association's website - where the thread does not appear at
  // all. In that order, because each of them photographs what the ones above it
  // did.
  {
    name: "news-compose",
    as: "administrator",
    goto: appPath("/admin/site/news"),
    prepare: [
      { fill: { label: "Rubrik" }, value: NOTICE.title },
      { fill: { label: "Adress" }, value: NOTICE.slug },
      {
        fill: { label: "Text" },
        value: `${NOTICE.opening}\n\n## Ta med\n\nHandskar och en hink.`,
      },
    ],
    waitFor: { button: "Spara nyheten" },
  },
  {
    name: "news-published",
    prepare: [
      { click: { button: "Spara nyheten" } },
      { see: { text: "Nyheten är sparad." } },
      // For anyone, and without mailing the members: the picture is of the
      // screen, and a capture run has no business putting post in anybody's
      // mailbox.
      { click: { label: "Alla" } },
      { click: { label: "Mejla medlemmarna" } },
      { click: { button: "Publicera" } },
    ],
    waitFor: { text: "Nyheten är publicerad." },
  },
  {
    /*
     * The notice as the house reads it, with the answer a resident leaves under
     * it.
     *
     * The resident persona rather than the member, and that is the capability
     * model rather than a convenience: news:comment is granted by living in the
     * building, so the account holding no tenant-ownership is the one that shows
     * the box is offered on residency alone. The same persona is offered no
     * motion form at all.
     */
    name: "news-reading",
    as: "resident",
    goto: appPath("/news"),
    prepare: [
      // The notice's own heading, which exists only once the list has arrived,
      // so the comment box below it is the one belonging to this notice.
      { see: { heading: NOTICE.title } },
      { fill: { label: "Din kommentar" }, value: NOTICE.comment },
      { click: { button: "Skicka kommentaren" } },
    ],
    // The comment as the thread read it back. Nothing on this screen is
    // optimistic, so the row arrives with the re-read rather than with the click
    // - which is exactly what makes it a marker that waits for the data.
    waitFor: { text: NOTICE.comment },
    capture: "page",
  },
  {
    /*
     * The whole of what the board may do to a thread: strike a comment through.
     *
     * The card on its own rather than the screen, because the picture is of one
     * state - the comment still there, its author still named, its text struck
     * through and readable to the board with the sentence saying who else can
     * read it. There is deliberately no control that takes it back.
     */
    name: "news-comment-struck",
    as: "administrator",
    goto: appPath("/news"),
    prepare: [
      { see: { heading: NOTICE.title } },
      { click: { button: `Stryk kommentaren från ${RESIDENT.name}` } },
    ],
    // The sentence that only appears once the struck comment has been read back
    // with its text: the strike-through is the server's answer, not the screen's
    // arithmetic. Whole, because a string target here matches exactly.
    waitFor: {
      text: "Struken. Texten visas för styrelsen och för den som skrev den.",
    },
    capture: { panel: "Kommentarer" },
  },
  {
    name: "site-news",
    as: "nobody",
    goto: "/nyheter",
    waitFor: { heading: NOTICE.title },
  },
  {
    name: "site-news-article",
    goto: `/nyheter/${NOTICE.slug}`,
    waitFor: {
      text: NOTICE.opening,
    },
  },
  // --- the association's website again ---------------------------------------
  {
    /*
     * The broker information page, generated from the facts the board records.
     * The walk records none, so this is the page as an association has it the
     * day the feature ships: its name and its organisation number, and not one
     * question it has not answered. That state is a decision rather than an
     * omission, and an image of it is the clearest place to see it.
     */
    name: "site-broker",
    as: "nobody",
    goto: "/maklarinfo",
    // The organisation number arrives with the association's own row rather
    // than with the document, so it is data and not a static heading.
    waitFor: { text: HOUSING_COOPERATIVE.organizationNumber },
  },

  // --- the menu on the association's own website -----------------------------
  // Last, because arranging the menu changes what the website's front page is
  // and every screen above has already been photographed against the one the
  // wizard wrote.
  {
    // The instance already has the entry the wizard wrote for its first page.
    // A second one is added beside it so the picture shows a menu being
    // arranged rather than an empty list.
    name: "site-menu",
    as: "administrator",
    goto: appPath("/admin/site/menu"),
    prepare: [
      { select: { combobox: "Sida" }, option: "Integritetspolicy" },
      { fill: { label: "Vad menyn säger" }, value: "Integritet" },
      { click: { button: "Lägg till posten" } },
      { see: { text: "Posten ligger i menyn." } },
    ],
    waitFor: { button: "Ändra Integritet" },
    capture: "page",
  },
  {
    // And the same menu as a visitor with no account reads it, on the website
    // itself rather than in the application.
    name: "site-menu-public",
    as: "nobody",
    goto: "/",
    waitFor: { text: "Integritet" },
  },

  // --- the blocks that name what the instance already holds -------------------
  // Last, because the first of these two writes the front page and the second
  // photographs what it wrote. Three of the four blocks show what the instance
  // holds and this walk holds none of it - no document is filed, no
  // publication consent is recorded and no association fact is entered - so
  // they render as nothing on the page and the editor is where they can be
  // seen at all. That is the state a board is in the moment it inserts one,
  // and the hints beside them are what say so.
  {
    name: "site-page-blocks",
    as: "administrator",
    goto: appPath("/admin/site"),
    prepare: [
      { click: { button: "Redigera", first: true } },
      { see: { label: "Stycke 1" } },
      { click: { button: "Lägg till en dokumentlista" } },
      { click: { button: "Lägg till styrelsen" } },
      { click: { button: "Lägg till föreningens uppgifter" } },
      { click: { button: "Lägg till frågor och svar" } },
      { fill: { label: "Fråga 1" }, value: "Var finns tvättstugan?" },
      {
        fill: { label: "Svar 1" },
        value: "I källaren i port 12, öppen mellan sju och tjugoett.",
      },
      { click: { button: "Spara" } },
      { see: { text: "Sparad." } },
    ],
    waitFor: { label: "Svar 1" },
    capture: "page",
  },
  {
    // The one of the four with content of its own, on the page the entry above
    // saved. The board writes the questions and the answers here rather than on
    // a screen of their own, which is why this block needs no feature behind
    // it.
    name: "site-faq",
    as: "nobody",
    goto: "/",
    waitFor: { text: "Var finns tvättstugan?" },
  },

  // --- bookings ---------------------------------------------------------------
  // Three screens in one order, because each photographs what the one above it
  // did: the board names a laundry room, a resident takes an hour in it, and the
  // board reads who has that hour. Nothing is bookable before the first of them
  // - the wizard seeds no resource, and a board naming its own is where this
  // module starts.
  {
    /*
     * The catalogue, with a laundry room in it.
     *
     * The hours and the slot length divide evenly on purpose: 07:00 to 21:00 in
     * seven-hour slots is two slots a day, and a length that left a remainder is
     * refused at save time. A picture of a refused form is not what this card is
     * about.
     */
    name: "settings-bookable-resources",
    as: "administrator",
    goto: appPath("/settings"),
    prepare: [
      { see: { panel: "Bokningsbara resurser" } },
      { fill: { label: "Resursens namn" }, value: LAUNDRY.name },
      {
        fill: { label: "Vad de boende behöver veta" },
        value: LAUNDRY.description,
      },
      {
        fill: { label: "Passets längd i minuter" },
        value: LAUNDRY.slotMinutes,
      },
      { fill: { label: "Öppnar" }, value: LAUNDRY.opensAt },
      { fill: { label: "Stänger" }, value: LAUNDRY.closesAt },
      { fill: { label: "Bokningar per vecka" }, value: "2" },
      { click: { button: "Lägg till resurs" } },
    ],
    // The withdraw control on the row the save wrote. It exists only once the
    // catalogue has been read back with the resource in it, which is what makes
    // it a marker for the data rather than for the card.
    waitFor: { button: `Ta ${LAUNDRY.name} ur bokning` },
    capture: { panel: "Bokningsbara resurser" },
  },
  {
    /*
     * A resident taking an hour, and what they hold afterwards.
     *
     * The resident rather than the administrator, who holds every capability and
     * no apartment: a booking is counted against an apartment the booker lives
     * in, so the account that runs this instance cannot take a laundry hour and
     * is told so. Somebody who lives here can.
     *
     * The first free slot of the week, whichever it is. A slot that has already
     * begun is named as passed rather than as bookable, so the name matched here
     * cannot land on one.
     */
    name: "bookings-resident",
    as: "resident",
    goto: appPath("/bookings"),
    prepare: [{ click: { button: /^Boka /, first: true } }],
    // The cancel control on the booking that was just made, which arrives with
    // the re-read of what this account holds rather than with the click.
    waitFor: { button: `Avboka ${LAUNDRY.name}` },
    capture: "page",
  },
  {
    /*
     * The board's half: who holds which hour, and cancelling it on their behalf.
     *
     * The card on its own rather than the whole screen, because this is the half
     * the capability exists for - and the administrator's own booking half above
     * it says only that they hold no apartment, which is a true picture of a
     * different thing.
     */
    name: "bookings-board",
    as: "administrator",
    goto: appPath("/bookings"),
    // The cancel-on-behalf control, which exists only once the month has been
    // read back with a live booking in it - the one the entry above made.
    waitFor: { button: /åt den boende$/, first: true },
    capture: { panel: "Hela kalendern" },
  },

  // --- motions ---------------------------------------------------------------
  // Three screens in one order, because each photographs what the one above it
  // did: an administrator records the deadline the association's bylaws set, a
  // member puts an item to the meeting inside it, and the board reads that item
  // in its queue. Nothing is on the queue before the second of them.
  //
  // The member rather than the resident, and that is the statute rather than a
  // convenience: EFL 6 kap. 15 §, applied to a housing cooperative by BRL
  // 9 kap. 14 §, gives the right to put an item to a general meeting to a
  // member. The resident persona holds no tenant-ownership and is offered no
  // form at all, which is why the middle entry cannot be theirs.
  {
    /*
     * The bylaws clause, recorded rather than defaulted.
     *
     * The platform holds no default here, so an empty card is what an instance
     * starts with and says nothing about how the setting works. Filled in, the
     * card shows the clause and the sentence that says intake stays open past
     * it - which is the part a board misreads if it is not on the picture.
     */
    name: "settings-motion-deadline",
    as: "administrator",
    goto: appPath("/settings"),
    prepare: [
      { see: { panel: MOTION_DEADLINE_CARD } },
      {
        fill: { label: "Månad", within: MOTION_DEADLINE_CARD },
        value: MOTION.deadlineMonth,
      },
      {
        fill: { label: "Dag", within: MOTION_DEADLINE_CARD },
        value: MOTION.deadlineDay,
      },
      { click: { button: "Spara", within: MOTION_DEADLINE_CARD } },
    ],
    /*
     * The card, which this route renders only once the stored settings have
     * arrived - and the fills above have already proved that they did.
     *
     * Not the confirmation beside it. That is a state the card leaves the moment
     * the settings it saved arrive again, so whether it is still up is a race
     * with a read that answers in a few hundred milliseconds; the settling wait
     * puts the picture after that read either way, which is what makes the two
     * images of this card the same on a rerun. Whether the clause was really
     * stored is asserted on the member's own screen below, where a date computed
     * from it is the first thing the entry looks for.
     */
    waitFor: { panel: MOTION_DEADLINE_CARD },
    capture: { panel: MOTION_DEADLINE_CARD },
  },
  {
    /*
     * A member putting an item to the meeting, and what she holds afterwards.
     *
     * The member persona rather than the administrator, who holds every
     * capability and no tenant-ownership: the right in EFL 6 kap. 15 § belongs
     * to a member, so the account that runs this instance is refused and would
     * be photographed being refused.
     */
    name: "motions-member",
    as: "member",
    goto: appPath("/motions"),
    prepare: [
      /*
       * The clause the entry above recorded, read from the side that depends on
       * it. The date in this sentence is computed from the deadline rather than
       * echoed back, so a save that did not land shows up here - one screen
       * after the card that made it, and before anything is put to the meeting.
       */
      { see: { text: /senast \d{4}-01-31/ } },
      { fill: { label: "Vad du föreslår, på en rad" }, value: MOTION.title },
      { fill: { label: "Förslaget" }, value: MOTION.body },
      { click: { button: "Skicka motionen" } },
    ],
    // The withdraw control on the motion that was just submitted, which arrives
    // with the re-read of what this account has put in rather than with the
    // click.
    waitFor: { button: `Återkalla motionen ${MOTION.title}` },
    capture: "page",
  },
  {
    /*
     * The board's half: what the members have put to the meeting, and recording
     * one as received.
     *
     * The card on its own rather than the whole screen, because this is the half
     * the capability exists for - the administrator's own intake half above it
     * would only show an account that may not submit.
     */
    name: "motions-board",
    as: "administrator",
    goto: appPath("/motions"),
    // The record-as-received control on the item the entry above put in, which
    // exists only once the queue has been read back with it.
    waitFor: {
      button: `Anteckna motionen ${MOTION.title} som mottagen`,
    },
    capture: { panel: "Motioner från medlemmarna" },
  },

  // --- events -----------------------------------------------------------------
  // Three screens in one order, because each photographs what the one above it
  // did: the board enters a cleaning day and publishes it, a resident puts their
  // name down for the first date, and the board reads who is coming. Nothing is
  // on the calendar before the first of them - the wizard seeds no events, and a
  // board arranging what the association does is where this module starts.
  //
  // The resident rather than the member, because putting your name down for the
  // cleaning day is part of living here rather than part of holding a
  // tenant-ownership: the capability comes from the residency, and the persona
  // who has one and nothing more is the honest reader of that half.
  {
    /*
     * The calendar the board keeps, with a recurring cleaning day on it.
     *
     * Entered and then published, in that order, because those are two acts: a
     * series is written before it is meant to be read, and publishing is what
     * decides who may read it. A card photographed before the second act would
     * show a draft, which says nothing about the audience.
     *
     * The card on its own rather than the whole screen, because this is the half
     * the capability exists for - and the administrator's own attending half
     * above it would only show a calendar with one date they have not signed up
     * to.
     */
    name: "events-board",
    as: "administrator",
    goto: appPath("/events"),
    prepare: [
      { fill: { label: "Vad det heter" }, value: CLEANING.title },
      { fill: { label: "Kategori" }, value: CLEANING.category },
      { fill: { label: "Var det är" }, value: CLEANING.location },
      { fill: { label: "Vad det handlar om" }, value: CLEANING.description },
      { fill: { label: "Första datumet" }, value: CLEANING.firstOn },
      { fill: { label: "Börjar" }, value: CLEANING.startsAt },
      { fill: { label: "Minuter" }, value: CLEANING.durationMinutes },
      // The rule first: the interval and the number of dates are offered only
      // once the series repeats at all, which is what the form has to say before
      // there is anything to fill in.
      { select: { combobox: "Hur ofta" }, option: CLEANING.frequency },
      { fill: { label: "Med intervall" }, value: CLEANING.interval },
      { fill: { label: "Antal tillfällen" }, value: CLEANING.count },
      // And the places only once sign-up is offered, for the same reason.
      { click: { label: "Det går att anmäla sig till det här evenemanget" } },
      { fill: { label: "Platser per tillfälle" }, value: CLEANING.capacity },
      { click: { button: "Lägg in evenemanget" } },
      { see: { button: `Publicera ${CLEANING.title}` } },
      { click: { button: `Publicera ${CLEANING.title}` } },
    ],
    // The audience the series carries, which reads this way only once the
    // publication has been written and the list read back with it. A draft's
    // chip says something else, so this marker stands for the act rather than
    // for the card.
    waitFor: { text: "Publicerat för medlemmarna" },
    capture: { panel: "Styrelsens kalender" },
  },
  {
    /*
     * A resident putting their name down, and what the calendar then says.
     *
     * The first date of the series, which is a month out: a date that had begun
     * would be stated as begun rather than offered, and the name matched here
     * cannot land on one.
     *
     * The whole page, because the point of this screen is what a resident is and
     * is not shown - how many places are gone, and nobody's name.
     */
    name: "events-resident",
    as: "resident",
    goto: appPath("/events"),
    prepare: [{ click: { button: /^Anmäl dig till /, first: true } }],
    // The way out of the place that was just taken, which arrives with the
    // re-read of the calendar rather than with the click.
    waitFor: { button: /^Avanmäl dig från / },
    capture: "page",
  },
  {
    /*
     * The roll-call (deltagarlistan): who is coming to one date.
     *
     * The half events:manage exists for. It is read when it is opened rather
     * than with the series, so the entry opens it - and the resident the entry
     * above signed up is what proves it was read.
     */
    name: "events-roll-call",
    as: "administrator",
    goto: appPath("/events"),
    prepare: [{ click: { button: /^Vilka kommer den /, first: true } }],
    // The resident who signed up above, which exists only once the roll-call has
    // come back. The first date of the two, which is the one they took.
    waitFor: { text: RESIDENT.name },
    capture: { panel: "Styrelsens kalender" },
  },
];

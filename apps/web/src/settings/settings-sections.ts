import type { TranslationKey } from "../i18n/translation-key";

/**
 * The sections of the settings screen, in the order its navigation lists them.
 *
 * Each is a route of its own, /settings/<id>, so a section can be linked to,
 * bookmarked and reached with the back button, and a screen that tells a board
 * to go and change something can send it to the right place rather than to the
 * top of a long page.
 *
 * The ids are part of those addresses. Renaming one breaks every link to it,
 * including the ones in emails already sent.
 */
export const SETTINGS_SECTIONS = [
  { id: "account", labelKey: "settings.sections.account" },
  { id: "association", labelKey: "settings.sections.association" },
  { id: "appearance", labelKey: "settings.sections.appearance" },
  { id: "communication", labelKey: "settings.sections.communication" },
  { id: "signups", labelKey: "settings.sections.signups" },
  { id: "issues-bookings", labelKey: "settings.sections.issuesBookings" },
  { id: "meetings", labelKey: "settings.sections.meetings" },
  { id: "data-protection", labelKey: "settings.sections.dataProtection" },
] as const satisfies readonly { id: string; labelKey: TranslationKey }[];

export type SettingsSectionId = (typeof SETTINGS_SECTIONS)[number]["id"];

/** What a viewer may do on this screen, read once from their capabilities. */
export interface SettingsAccess {
  canRead: boolean;
  canManage: boolean;
  canEditAddresses: boolean;
  canDecideSignup: boolean;
  canConfigureIssues: boolean;
  /** Placing a block on a page is a website write, whoever the panel is for. */
  canManageSite: boolean;
  canConfigureBookings: boolean;
}

export function settingsAccessOf(
  capabilities: readonly string[],
): SettingsAccess {
  return {
    canRead: capabilities.includes("association:read"),
    canManage: capabilities.includes("association:manage"),
    canEditAddresses: capabilities.includes("addressBook:write"),
    canDecideSignup: capabilities.includes("signupRequest:decide"),
    canConfigureIssues: capabilities.includes("issues:configure"),
    canManageSite: capabilities.includes("site:manage"),
    canConfigureBookings: capabilities.includes("bookings:configure"),
  };
}

export type SettingsPanelId =
  | "profile"
  | "security"
  | "housingCooperative"
  | "addresses"
  | "apartments"
  | "branding"
  | "themes"
  | "smtp"
  | "boardMailbox"
  | "sms"
  | "selfSignup"
  | "signupQueue"
  | "contactInbox"
  | "issueReporting"
  | "issueTypes"
  | "bookableResources"
  | "motionDeadline"
  | "meetingBylaws"
  | "retention"
  | "dataProtectionContacts"
  | "finances";

/**
 * What a panel is built from.
 *
 * - nothing: the panel belongs to whoever is signed in and reads for itself.
 * - addresses: the screen's shared read, which every panel but the account's
 *   waits for.
 * - settings: that read, and the instance settings in it, which are absent on
 *   an instance whose housing cooperative is not registered yet.
 */
export type SettingsPanelInput = "nothing" | "addresses" | "settings";

interface SettingsPanel {
  id: SettingsPanelId;
  section: SettingsSectionId;
  needs: SettingsPanelInput;
  /** Whether this viewer is offered the panel at all. */
  shownTo: (access: SettingsAccess) => boolean;
}

const EVERYONE = (): boolean => true;
const READERS = (access: SettingsAccess): boolean => access.canRead;

/**
 * Every panel, the one section that holds it, and who is offered it.
 *
 * One list rather than a set of panels per section, so a panel cannot end up in
 * two sections or in none. Hiding a panel is courtesy only - the API enforces
 * the same capabilities and refuses the call either way.
 *
 * Every panel about the instance needs association:read on top of its own
 * capability, because each of them sits on the screen's read of the instance
 * settings, which nobody without it makes.
 *
 * Within a section the order is the order the panels are shown in.
 */
export const SETTINGS_PANELS: readonly SettingsPanel[] = [
  // Your own account, which every account has whatever else it may do.
  { id: "profile", section: "account", needs: "nothing", shownTo: EVERYONE },
  { id: "security", section: "account", needs: "nothing", shownTo: EVERYONE },

  {
    id: "housingCooperative",
    section: "association",
    needs: "addresses",
    shownTo: READERS,
  },
  {
    id: "addresses",
    section: "association",
    needs: "addresses",
    shownTo: READERS,
  },
  {
    id: "apartments",
    section: "association",
    needs: "addresses",
    shownTo: READERS,
  },

  {
    id: "branding",
    section: "appearance",
    needs: "settings",
    shownTo: READERS,
  },
  {
    id: "themes",
    section: "appearance",
    needs: "settings",
    // Installing and switching themes is an administrator's job, and the API
    // refuses the calls for anyone else.
    shownTo: (access) => access.canRead && access.canManage,
  },

  { id: "smtp", section: "communication", needs: "settings", shownTo: READERS },
  {
    id: "boardMailbox",
    section: "communication",
    needs: "settings",
    shownTo: READERS,
  },
  { id: "sms", section: "communication", needs: "settings", shownTo: READERS },

  {
    id: "selfSignup",
    section: "signups",
    needs: "settings",
    shownTo: READERS,
  },
  {
    id: "signupQueue",
    section: "signups",
    needs: "settings",
    shownTo: (access) => access.canRead && access.canDecideSignup,
  },
  {
    id: "contactInbox",
    section: "signups",
    needs: "settings",
    shownTo: (access) => access.canRead && access.canDecideSignup,
  },

  {
    id: "issueReporting",
    section: "issues-bookings",
    needs: "settings",
    shownTo: READERS,
  },
  {
    id: "issueTypes",
    section: "issues-bookings",
    needs: "settings",
    shownTo: (access) => access.canRead && access.canConfigureIssues,
  },
  {
    id: "bookableResources",
    section: "issues-bookings",
    needs: "settings",
    shownTo: (access) => access.canRead && access.canConfigureBookings,
  },

  {
    id: "motionDeadline",
    section: "meetings",
    needs: "settings",
    shownTo: READERS,
  },
  {
    id: "meetingBylaws",
    section: "meetings",
    needs: "settings",
    shownTo: READERS,
  },

  {
    id: "retention",
    section: "data-protection",
    needs: "settings",
    shownTo: READERS,
  },
  {
    id: "dataProtectionContacts",
    section: "data-protection",
    needs: "settings",
    shownTo: READERS,
  },
  {
    id: "finances",
    section: "data-protection",
    needs: "settings",
    shownTo: READERS,
  },
];

/** The panels of one section this viewer is offered, in the order shown. */
export function panelsIn(
  section: SettingsSectionId,
  access: SettingsAccess,
): readonly SettingsPanel[] {
  return SETTINGS_PANELS.filter(
    (panel) => panel.section === section && panel.shownTo(access),
  );
}

/**
 * The sections this viewer is offered, in navigation order: those holding at
 * least one panel they are offered. A section with nothing in it for them is
 * neither listed nor reachable, so nobody lands on an empty page.
 */
export function sectionsFor(
  access: SettingsAccess,
): readonly (typeof SETTINGS_SECTIONS)[number][] {
  return SETTINGS_SECTIONS.filter(
    (section) => panelsIn(section.id, access).length > 0,
  );
}

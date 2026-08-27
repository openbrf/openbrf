/**
 * The public token contract.
 *
 * This is an API, not a stylesheet. Themes are written against these names and
 * plugin UIs style themselves with them, so the names are versioned with
 * semver and the rules below are binding (decisions 42 and 46):
 *
 *   Names are English and semantic. They describe the ROLE a colour plays, not
 *   the colour itself and not the metaphor the default theme uses. "Porttavlan"
 *   is the default theme that supplies values; it is not the contract.
 *
 *   Meanings are platform law. A theme changes what --obrf-status-warn LOOKS
 *   like; it can never change what it MEANS. Colour carries legal semantics in
 *   a statutory register, so this one is not negotiable.
 *
 *   Adding a token is a minor version and must ship a fallback derived from an
 *   existing token, so a theme built against an older minor keeps working.
 *   Renaming or removing one is a major version with a migration note.
 */

/** Semver of the contract itself, not of any theme. */
export const TOKEN_CONTRACT_VERSION = "1.0.0";

/** Prefixed on emit, so a theme's own variables can never collide with ours. */
export const TOKEN_PREFIX = "--obrf-";

/**
 * Every token in the contract.
 *
 * `since` is the contract version that introduced the token. A theme declaring
 * an older version is not required to provide anything newer; resolution fills
 * those from `fallbackFrom`.
 */
export interface TokenDefinition {
  name: string;
  /** What this token is for. Part of the contract: themes rely on it. */
  role: string;
  since: string;
  /**
   * Token to derive from when a theme does not supply this one. Null means the
   * token is mandatory for every theme at its declared version.
   */
  fallbackFrom: string | null;
}

export const TOKENS = [
  // --- Surfaces in the room -----------------------------------------------
  {
    name: "surface-page",
    role: "Page background.",
    since: "1.0.0",
    fallbackFrom: null,
  },
  {
    name: "surface-raised",
    role: "Cards and panels sitting on the page.",
    since: "1.0.0",
    fallbackFrom: null,
  },
  {
    name: "surface-sunken",
    role: "Secondary surface: table heads, inset areas.",
    since: "1.0.0",
    fallbackFrom: "surface-raised",
  },

  // --- Text ---------------------------------------------------------------
  {
    name: "text-primary",
    role: "Body and heading text on page and raised surfaces.",
    since: "1.0.0",
    fallbackFrom: null,
  },
  {
    name: "text-secondary",
    role: "Metadata and de-emphasised text. Must still pass AA.",
    since: "1.0.0",
    fallbackFrom: "text-primary",
  },

  // --- Borders ------------------------------------------------------------
  {
    name: "border-subtle",
    role: "Dividers and hairlines.",
    since: "1.0.0",
    fallbackFrom: null,
  },
  {
    name: "border-strong",
    role: "Control borders, input outlines.",
    since: "1.0.0",
    fallbackFrom: "border-subtle",
  },

  // --- The register surface ----------------------------------------------
  // The statutory register is rendered on its own committed surface, which in
  // the default theme is a dark board. A theme may make it light, but it stays
  // a distinct surface family so the register reads as a register.
  {
    name: "surface-register",
    role: "The surface carrying the statutory register.",
    since: "1.0.0",
    fallbackFrom: null,
  },
  {
    name: "surface-register-raised",
    role: "Header and group rows within the register surface.",
    since: "1.0.0",
    fallbackFrom: "surface-register",
  },
  {
    name: "text-register",
    role: "Primary text on the register surface.",
    since: "1.0.0",
    fallbackFrom: null,
  },
  {
    name: "text-register-secondary",
    role: "Secondary text on the register surface. Must still pass AA.",
    since: "1.0.0",
    fallbackFrom: "text-register",
  },
  {
    name: "border-register",
    role: "Row dividers on the register surface.",
    since: "1.0.0",
    fallbackFrom: null,
  },

  // --- Trust accent -------------------------------------------------------
  // Reserved for positions of trust and trust actions. It is not a decoration.
  {
    name: "accent-trust",
    role: "Positions of trust, active selection, links, focus rings.",
    since: "1.0.0",
    fallbackFrom: null,
  },
  {
    name: "accent-trust-hover",
    role: "Hover state of the trust accent.",
    since: "1.0.0",
    fallbackFrom: "accent-trust",
  },
  {
    name: "accent-trust-soft",
    role: "Tinted background carrying the trust accent.",
    since: "1.0.0",
    fallbackFrom: "accent-trust",
  },
  {
    name: "accent-trust-register",
    role: "Trust accent as used ON the register surface, for AA contrast.",
    since: "1.0.0",
    fallbackFrom: "accent-trust",
  },
  {
    name: "on-accent-trust",
    role: "Text and icons placed on a trust-accent ground.",
    since: "1.0.0",
    fallbackFrom: null,
  },

  // --- Status: colour as law ---------------------------------------------
  // Each of these means exactly one thing everywhere in the product. A theme
  // sets the value; the meaning is fixed.
  {
    name: "status-ok",
    role: "Confirmed. Meaning is fixed by the platform.",
    since: "1.0.0",
    fallbackFrom: null,
  },
  {
    name: "status-ok-soft",
    role: "Tinted background for the confirmed state.",
    since: "1.0.0",
    fallbackFrom: "status-ok",
  },
  {
    name: "status-warn",
    role: "Protected personal data and caution. Meaning is fixed.",
    since: "1.0.0",
    fallbackFrom: null,
  },
  {
    name: "status-warn-soft",
    role: "Tinted background for the caution state.",
    since: "1.0.0",
    fallbackFrom: "status-warn",
  },
  {
    name: "status-warn-register",
    role: "Caution as used ON the register surface, for AA contrast.",
    since: "1.0.0",
    fallbackFrom: "status-warn",
  },
  {
    name: "status-danger",
    role: "Destructive actions and failures. Meaning is fixed.",
    since: "1.0.0",
    fallbackFrom: null,
  },
  {
    name: "status-danger-soft",
    role: "Tinted background for the danger state.",
    since: "1.0.0",
    fallbackFrom: "status-danger",
  },
  {
    name: "on-status-danger",
    role: "Text and icons placed on a danger ground.",
    since: "1.0.0",
    fallbackFrom: null,
  },
  {
    name: "status-info",
    role: "Neutral information. Meaning is fixed.",
    since: "1.0.0",
    fallbackFrom: null,
  },
  {
    name: "status-info-soft",
    role: "Tinted background for the information state.",
    since: "1.0.0",
    fallbackFrom: "status-info",
  },

  // --- Form ---------------------------------------------------------------
  {
    name: "radius-control",
    role: "Corner radius of buttons, inputs and chips.",
    since: "1.0.0",
    fallbackFrom: null,
  },
  {
    name: "radius-panel",
    role: "Corner radius of cards and panels.",
    since: "1.0.0",
    fallbackFrom: null,
  },
  {
    name: "shadow-raised",
    role: "The single elevation level. Themes may set none.",
    since: "1.0.0",
    fallbackFrom: null,
  },

  // --- Motion -------------------------------------------------------------
  {
    name: "motion-duration",
    role: "Duration of state transitions.",
    since: "1.0.0",
    fallbackFrom: null,
  },
  {
    name: "motion-easing",
    role: "Easing of state transitions.",
    since: "1.0.0",
    fallbackFrom: null,
  },

  // --- Typography ---------------------------------------------------------
  {
    name: "font-ui",
    role: "Interface and body typeface.",
    since: "1.0.0",
    fallbackFrom: null,
  },
  {
    name: "font-data",
    role: "Monospace face for all register data. Columns must align.",
    since: "1.0.0",
    fallbackFrom: "font-ui",
  },
] as const satisfies readonly TokenDefinition[];

export type TokenName = (typeof TOKENS)[number]["name"];

/** A complete set of values for the contract. */
export type TokenSet = Record<TokenName, string>;

/** What a theme provides: any subset, completed by resolution. */
export type PartialTokenSet = Partial<Record<TokenName, string>>;

export const TOKEN_NAMES: readonly TokenName[] = TOKENS.map(
  (token) => token.name,
);

/** Tokens every theme must supply: those with no fallback to derive from. */
export const REQUIRED_TOKEN_NAMES: readonly TokenName[] = TOKENS.filter(
  (token) => token.fallbackFrom === null,
).map((token) => token.name);

export function tokenDefinition(name: TokenName): TokenDefinition {
  const found = TOKENS.find((token) => token.name === name);
  if (found === undefined) {
    throw new Error(`Unknown token: ${name}`);
  }
  return found;
}

/** The CSS custom property name for a token. */
export function cssVariableName(name: TokenName): string {
  return `${TOKEN_PREFIX}${name}`;
}

/**
 * Text-on-surface pairs that must meet WCAG AA (4.5:1).
 *
 * The register pairs are the reason this list exists: the member and apartment
 * registers are statutory documents, and a theme must not be able to render
 * them hard to read. The room-side pairs are held to the same bar, because
 * DESIGN.md and CONTRIBUTING require AA even at 13px.
 */
export interface ContrastPair {
  foreground: TokenName;
  background: TokenName;
  /** True for pairs whose failure blocks a theme from installing at all. */
  statutory: boolean;
}

export const CONTRAST_PAIRS: readonly ContrastPair[] = [
  // The register: statutory.
  {
    foreground: "text-register",
    background: "surface-register",
    statutory: true,
  },
  {
    foreground: "text-register-secondary",
    background: "surface-register",
    statutory: true,
  },
  {
    foreground: "text-register",
    background: "surface-register-raised",
    statutory: true,
  },
  {
    foreground: "text-register-secondary",
    background: "surface-register-raised",
    statutory: true,
  },
  {
    foreground: "accent-trust-register",
    background: "surface-register",
    statutory: true,
  },
  {
    foreground: "status-warn-register",
    background: "surface-register",
    statutory: true,
  },

  // The room.
  { foreground: "text-primary", background: "surface-page", statutory: false },
  {
    foreground: "text-primary",
    background: "surface-raised",
    statutory: false,
  },
  {
    foreground: "text-secondary",
    background: "surface-page",
    statutory: false,
  },
  {
    foreground: "text-secondary",
    background: "surface-raised",
    statutory: false,
  },
  { foreground: "accent-trust", background: "surface-page", statutory: false },
  {
    foreground: "accent-trust",
    background: "surface-raised",
    statutory: false,
  },
  {
    foreground: "on-accent-trust",
    background: "accent-trust",
    statutory: false,
  },
  {
    foreground: "status-danger",
    background: "surface-raised",
    statutory: false,
  },
  {
    foreground: "on-status-danger",
    background: "status-danger",
    statutory: false,
  },
  { foreground: "status-ok", background: "surface-raised", statutory: false },
  { foreground: "status-warn", background: "surface-raised", statutory: false },
  { foreground: "status-info", background: "surface-raised", statutory: false },
] as const satisfies readonly ContrastPair[];

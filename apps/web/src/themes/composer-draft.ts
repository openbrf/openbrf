import {
  checkContrast,
  normalizeColor,
  parseColor,
  PORTTAVLAN_DARK,
  PORTTAVLAN_ID,
  PORTTAVLAN_LIGHT,
  TOKEN_NAMES,
  type TokenName,
  type TokenSet,
} from "@openbrf/tokens";

import type {
  ThemeLintFinding,
  ThemeRendering,
  ThemeTokenValues,
} from "../api/themes";
import type { TranslationKey } from "../i18n/translation-key";

/**
 * The draft a theme is composed from, before anything is saved.
 *
 * Two rules shape this file. A composed theme states only what it changes, so
 * an override equal to the value it would inherit is not an override and is
 * pruned before it reaches the manifest - otherwise a board that opened the
 * form and saved it would turn a four-line child theme into a full copy of its
 * parent. And what the composer previews has to be what the server will build:
 * the parent's resolved values with the draft laid over them, in the same
 * rendering shape the preview endpoint returns.
 *
 * The contrast measured here is advice. It runs in the browser on values that
 * have not been saved, so it can say what a colour would do; the install lint
 * on the server is what refuses one, and it runs again on every save.
 */

/** The id the draft rendering carries. Never saved: it names a preview. */
export const DRAFT_THEME_ID = "composer-draft";

/**
 * The tokens the composer offers.
 *
 * Selected by what the default theme's own value IS rather than by name, so a
 * colour token added to a later contract appears here without this list being
 * edited, and a radius or a duration never does. Everything absent from the
 * form is absent from the manifest, and therefore inherited.
 */
export const COLOUR_TOKEN_NAMES: readonly TokenName[] = TOKEN_NAMES.filter(
  (name) => parseColor(PORTTAVLAN_LIGHT[name]) !== null,
);

export interface ComposerGroup {
  name: string;
  labelKey: TranslationKey;
  tokens: readonly TokenName[];
}

/**
 * How the colour tokens are grouped for the form.
 *
 * By the families the token contract itself is written in, and the register
 * family comes first among the matches on purpose: `surface-register` is a
 * register colour before it is a surface, and grouping it with the room would
 * scatter the statutory pairs across three sections of the form.
 */
const GROUP_DEFINITIONS: readonly {
  name: string;
  labelKey: TranslationKey;
  matches: (token: string) => boolean;
}[] = [
  {
    name: "register",
    labelKey: "themeCatalog.composer.groups.register",
    matches: (token) => token.includes("register"),
  },
  {
    name: "surfaces",
    labelKey: "themeCatalog.composer.groups.surfaces",
    matches: (token) => token.startsWith("surface-"),
  },
  {
    name: "text",
    labelKey: "themeCatalog.composer.groups.text",
    matches: (token) => token.startsWith("text-"),
  },
  {
    name: "borders",
    labelKey: "themeCatalog.composer.groups.borders",
    matches: (token) => token.startsWith("border-"),
  },
  {
    name: "accent",
    labelKey: "themeCatalog.composer.groups.accent",
    matches: (token) =>
      token.startsWith("accent-") || token.startsWith("on-accent-"),
  },
  {
    name: "status",
    labelKey: "themeCatalog.composer.groups.status",
    matches: (token) =>
      token.startsWith("status-") || token.startsWith("on-status-"),
  },
];

/**
 * The groups, in the order the form renders them.
 *
 * Each colour goes to the FIRST definition that claims it, which is what makes
 * the register family win over the surface, text and border families it would
 * otherwise also match. A colour this build cannot place - one from a contract
 * newer than the interface - still gets a row, under a heading that says so.
 * Dropping it would silently take a value away from the theme being composed.
 */
export function composerGroups(): ComposerGroup[] {
  const claimed = new Map<string, TokenName[]>(
    GROUP_DEFINITIONS.map((definition) => [definition.name, []]),
  );
  const other: TokenName[] = [];

  for (const token of COLOUR_TOKEN_NAMES) {
    const definition = GROUP_DEFINITIONS.find((candidate) =>
      candidate.matches(token),
    );
    if (definition === undefined) {
      other.push(token);
      continue;
    }
    claimed.get(definition.name)?.push(token);
  }

  const groups: ComposerGroup[] = GROUP_DEFINITIONS.map((definition) => ({
    name: definition.name,
    labelKey: definition.labelKey,
    tokens: claimed.get(definition.name) ?? [],
  })).filter((group) => group.tokens.length > 0);

  if (other.length > 0) {
    groups.push({
      name: "other",
      labelKey: "themeCatalog.composer.groups.other",
      tokens: other,
    });
  }

  return groups;
}

/**
 * The default theme, in the shape a rendering arrives in.
 *
 * Built here rather than fetched: its values ship with the application, so
 * asking the server for them would be a request for something already in the
 * bundle. Every other parent is read through the preview endpoint, which is
 * what resolves an installed theme's own inheritance chain.
 */
export function builtInRendering(): ThemeRendering {
  return {
    id: PORTTAVLAN_ID,
    name: "Porttavlan",
    builtIn: true,
    modes: { light: { ...PORTTAVLAN_LIGHT }, dark: { ...PORTTAVLAN_DARK } },
    fontFaces: [],
    viewVariants: {},
    logoUrl: null,
  };
}

export interface ComposerDraft {
  displayName: string;
  modes: { light: ThemeTokenValues; dark: ThemeTokenValues };
}

/**
 * The overrides a draft really states.
 *
 * An empty field is not a value, and a value equal to the one it would inherit
 * is not an override. Both are dropped, so the theme that is saved is the four
 * lines the board actually changed.
 */
export function pruneOverrides(
  inherited: ThemeTokenValues,
  overrides: ThemeTokenValues,
): ThemeTokenValues {
  const pruned: ThemeTokenValues = {};

  for (const [name, raw] of Object.entries(overrides)) {
    const value = raw.trim();
    if (value === "") {
      continue;
    }
    const parent = inherited[name];
    if (parent !== undefined && sameColour(parent, value)) {
      continue;
    }
    pruned[name] = value;
  }

  return pruned;
}

/**
 * Compares two colours as colours rather than as text.
 *
 * `#EFEDE7` and `#efede7` are the same colour, and the colour input writes the
 * lowercase form of whatever the default theme states in uppercase. Comparing
 * the strings would record every field the board merely looked at as an
 * override.
 */
function sameColour(left: string, right: string): boolean {
  const a = normalizeColor(left);
  const b = normalizeColor(right);
  return a === null || b === null ? left.trim() === right.trim() : a === b;
}

/**
 * What the draft renders as, for the preview runtime.
 *
 * The parent's resolved values with the pruned overrides laid over them, which
 * is the same result the server's own resolution produces for the saved theme.
 *
 * Fonts and view variants are deliberately dropped rather than inherited,
 * because that is what the saved theme does: a composed manifest bundles no
 * fonts and selects no layout, and both are read from a theme's own row rather
 * than resolved along the inheritance chain. A preview that carried the
 * parent's would show a board something the theme will not do.
 */
export function draftRendering(
  parent: ThemeRendering,
  draft: ComposerDraft,
): ThemeRendering {
  const name = draft.displayName.trim();

  return {
    id: DRAFT_THEME_ID,
    name: name === "" ? parent.name : name,
    builtIn: false,
    modes: {
      light: overlay(parent.modes.light, draft.modes.light),
      dark: overlay(parent.modes.dark, draft.modes.dark),
    },
    fontFaces: [],
    viewVariants: {},
    logoUrl: null,
  };
}

function overlay(
  inherited: ThemeTokenValues,
  overrides: ThemeTokenValues,
): ThemeTokenValues {
  return { ...inherited, ...pruneOverrides(inherited, overrides) };
}

/**
 * What the contrast pairs measure for a draft, in the shape a refusal travels
 * in, so one component renders both.
 *
 * Advice, not a gate: these are values nobody has saved, and the server runs
 * the same measurement again on every save. What it buys is that a board sees
 * a statutory pair fail while they are still choosing the colour, rather than
 * on a refusal after they have chosen the rest.
 */
export function draftFindings(
  rendering: ThemeRendering,
): readonly ThemeLintFinding[] {
  const findings: ThemeLintFinding[] = [];

  for (const mode of ["light", "dark"] as const) {
    for (const finding of checkContrast(rendering.modes[mode] as TokenSet)) {
      findings.push({
        rule: "contrast",
        severity: "error",
        detail: {
          mode,
          foreground: finding.foreground,
          background: finding.background,
          // The lint sends -1 for a colour it could not read at all, and the
          // findings list already reads that as "?".
          ratio: finding.ratio ?? -1,
          required: finding.required,
          statutory: finding.statutory,
        },
      });
    }
  }

  return findings;
}

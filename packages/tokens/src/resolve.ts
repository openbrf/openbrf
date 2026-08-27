import {
  cssVariableName,
  type PartialTokenSet,
  TOKENS,
  type TokenName,
  type TokenSet,
} from "./contract.ts";

/**
 * Completes a partial token set into a full one.
 *
 * Two things happen here, in order:
 *
 *   Inheritance. A theme declaring `extends` starts from its parent's values
 *   and overrides selectively, so a theme only states what it changes
 *   (decision 48, the WordPress child-theme idea).
 *
 *   Fallback derivation. Anything still missing is filled from the token named
 *   in the contract's fallbackFrom chain. This is what lets the core add a
 *   token in a minor version without breaking themes written before it existed
 *   (decision 42).
 *
 * A token with no fallback and no value is a genuine gap and is reported rather
 * than silently emitted as empty, because an empty custom property renders as
 * an invisible element rather than an obvious defect.
 */
export interface ResolveResult {
  tokens: TokenSet;
  /** Tokens filled from a fallback rather than stated. */
  derived: TokenName[];
  /** Required tokens that were missing entirely. */
  missing: TokenName[];
}

export function resolveTokens(
  theme: PartialTokenSet,
  inheritFrom: PartialTokenSet = {},
): ResolveResult {
  const merged: PartialTokenSet = { ...inheritFrom, ...theme };
  const resolved: Partial<Record<TokenName, string>> = {};
  const derived: TokenName[] = [];
  const missing: TokenName[] = [];

  for (const definition of TOKENS) {
    const name = definition.name;
    const stated = merged[name];

    if (stated !== undefined && stated !== "") {
      resolved[name] = stated;
      continue;
    }

    const fromFallback = followFallback(definition.fallbackFrom, merged);
    if (fromFallback === undefined) {
      missing.push(name);
      continue;
    }

    resolved[name] = fromFallback;
    derived.push(name);
  }

  return {
    // Missing tokens are reported above; callers that care check `missing`.
    tokens: resolved as TokenSet,
    derived,
    missing,
  };
}

/**
 * Walks the fallback chain until a stated value is found.
 *
 * The chain is followed rather than checked one level deep so a theme that
 * states only `status-warn` still yields both `status-warn-soft` and
 * `status-warn-register`.
 */
function followFallback(
  from: string | null,
  values: PartialTokenSet,
): string | undefined {
  const seen = new Set<string>();
  let current = from;

  while (current !== null && !seen.has(current)) {
    seen.add(current);
    const value = values[current as TokenName];
    if (value !== undefined && value !== "") {
      return value;
    }
    const next = TOKENS.find((token) => token.name === current);
    current = next?.fallbackFrom ?? null;
  }

  return undefined;
}

/**
 * Renders a token set as CSS custom property declarations.
 *
 * Values are emitted verbatim: the caller is responsible for having validated
 * them (theme lint does this at install time). Nothing here interpolates
 * untrusted input into a selector.
 */
export function tokensToCssDeclarations(tokens: TokenSet): string {
  return Object.entries(tokens)
    .map(
      ([name, value]) => `  ${cssVariableName(name as TokenName)}: ${value};`,
    )
    .join("\n");
}

/**
 * Builds the stylesheet that drives theming.
 *
 * The three-block shape is deliberate and mirrors how a viewer's preference
 * actually works:
 *
 *   :root holds the light values, so light is what renders when nothing else
 *   applies.
 *
 *   A prefers-color-scheme block supplies dark for viewers whose system asks
 *   for it, guarded so an explicit light choice still wins.
 *
 *   A [data-theme="dark"] block lets an explicit choice override the system in
 *   both directions.
 *
 * Defining a value only inside a media query would make it unreachable for a
 * viewer who has chosen a mode explicitly.
 */
export function buildThemeStylesheet(modes: {
  light: TokenSet;
  dark: TokenSet;
}): string {
  return [
    ":root {",
    tokensToCssDeclarations(modes.light),
    "}",
    "",
    "@media (prefers-color-scheme: dark) {",
    '  :root:not([data-theme="light"]) {',
    indent(tokensToCssDeclarations(modes.dark)),
    "  }",
    "}",
    "",
    ':root[data-theme="dark"] {',
    tokensToCssDeclarations(modes.dark),
    "}",
    "",
  ].join("\n");
}

function indent(block: string): string {
  return block
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n");
}

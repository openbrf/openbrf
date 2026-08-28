import {
  type PartialTokenSet,
  PORTTAVLAN_DARK,
  PORTTAVLAN_ID,
  PORTTAVLAN_LIGHT,
  resolveTokens,
  type ResolveResult,
  TOKEN_NAMES,
  type TokenName,
} from "@openbrf/tokens";

/**
 * Theme inheritance.
 *
 * A theme declares `extends` and states only what it changes, the way a
 * WordPress child theme does. The default theme is always inheritable and
 * always present, so a theme that only wants a different accent is four lines
 * long and keeps working when the core adds a token.
 *
 * Resolution happens in two steps, and the order matters. Inheritance first:
 * the chain from the root ancestor down to the theme itself is merged, so a
 * value a theme states wins over the same value in its parent. Then the token
 * contract's own fallback chain fills whatever is still missing, which is what
 * lets a core release add a token without breaking a theme written before it
 * existed.
 */

/** One theme as inheritance sees it: an identity, a parent, and its values. */
export interface ThemeChainEntry {
  id: string;
  extends: string | null;
  modes: { light: PartialTokenSet; dark: PartialTokenSet };
}

/** Looks a theme up by id. Returns undefined for a theme that is not installed. */
export type ThemeLookup = (id: string) => ThemeChainEntry | undefined;

/** The built-in default theme, which every installed theme may inherit from. */
export const BUILT_IN_THEME: ThemeChainEntry = {
  id: PORTTAVLAN_ID,
  extends: null,
  modes: { light: PORTTAVLAN_LIGHT, dark: PORTTAVLAN_DARK },
};

export type ChainResult =
  | { ok: true; chain: readonly ThemeChainEntry[] }
  | {
      ok: false;
      reason: "missing-parent" | "cycle" | "unknown-theme";
      themeId: string;
    };

/** How deep an inheritance chain may go before it is treated as a mistake. */
const MAX_CHAIN_DEPTH = 16;

/**
 * Walks a theme's ancestry, root first.
 *
 * A cycle is reported rather than followed: `extends` is author-supplied, and
 * two themes naming each other would otherwise loop until the process dies. A
 * missing parent is reported too - the alternative is silently resolving
 * against the core fallbacks and shipping a theme that looks nothing like what
 * its author saw.
 */
export function resolveThemeChain(
  id: string,
  lookup: ThemeLookup,
): ChainResult {
  const chain: ThemeChainEntry[] = [];
  const seen = new Set<string>();
  let current: string | null = id;

  while (current !== null) {
    if (seen.has(current)) {
      return { ok: false, reason: "cycle", themeId: current };
    }
    seen.add(current);

    const entry = lookup(current);
    if (entry === undefined) {
      return {
        ok: false,
        reason: chain.length === 0 ? "unknown-theme" : "missing-parent",
        themeId: current,
      };
    }

    chain.unshift(entry);
    if (chain.length > MAX_CHAIN_DEPTH) {
      return { ok: false, reason: "cycle", themeId: current };
    }
    current = entry.extends;
  }

  return { ok: true, chain };
}

/** Merges a chain, root first, so a descendant's value wins. */
export function mergeChain(chain: readonly ThemeChainEntry[]): {
  light: PartialTokenSet;
  dark: PartialTokenSet;
} {
  const light: PartialTokenSet = {};
  const dark: PartialTokenSet = {};

  for (const entry of chain) {
    Object.assign(light, keepKnownTokens(entry.modes.light));
    Object.assign(dark, keepKnownTokens(entry.modes.dark));
  }

  return { light, dark };
}

/**
 * Drops names this contract version does not define.
 *
 * A theme written against a later minor may carry a token this core has never
 * heard of. Keeping it would put an unknown custom property into the emitted
 * stylesheet; dropping it renders the theme as this core understands it, which
 * is the behaviour the contract's minor-version rule promises. The linter
 * reports the dropped names so the author sees them.
 */
function keepKnownTokens(values: PartialTokenSet): PartialTokenSet {
  const known: PartialTokenSet = {};
  for (const name of TOKEN_NAMES) {
    const value = values[name];
    if (value !== undefined) {
      known[name] = value;
    }
  }
  return known;
}

/** Names a theme states that this contract version does not define. */
export function unknownTokenNames(
  values: Readonly<Record<string, string>>,
): string[] {
  const known = new Set<string>(TOKEN_NAMES as readonly string[]);
  return Object.keys(values).filter((name) => !known.has(name as TokenName));
}

export interface ResolvedThemeModes {
  light: ResolveResult;
  dark: ResolveResult;
}

/** Merges a chain and then fills the contract's own fallbacks. */
export function resolveChainTokens(
  chain: readonly ThemeChainEntry[],
): ResolvedThemeModes {
  const merged = mergeChain(chain);
  return {
    light: resolveTokens(merged.light),
    dark: resolveTokens(merged.dark),
  };
}

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

export class TokenValueError extends Error {
  constructor(readonly offending: { token: string; reason: string }[]) {
    super(
      `Refusing to emit CSS for unsafe token values:\n  ${offending
        .map((entry) => `${entry.token}: ${entry.reason}`)
        .join("\n  ")}`,
    );
    this.name = "TokenValueError";
  }
}

/**
 * Every reason a token value can be refused, named rather than described.
 *
 * The prose below is English and stays English: it is thrown at a developer.
 * An install refusal is read by a board member in their own language, so what
 * travels out of this package to be shown is the code, and the sentence is a
 * translation of it. Listed as values rather than as a bare union so a caller
 * can walk them and prove it has a sentence for each.
 */
export const TOKEN_VALUE_PROBLEM_CODES = [
  "semicolon-or-brace",
  "angle-bracket",
  "backslash-escape",
  "at-rule",
  "comment-marker",
  "url",
  "expression",
  "control-character",
  "unbalanced-quote",
  "unbalanced-parenthesis",
] as const;

export type TokenValueProblemCode = (typeof TOKEN_VALUE_PROBLEM_CODES)[number];

/**
 * Things a token value may never contain, and why.
 *
 * A token value lands inside a declaration block, so anything that can close
 * that declaration or block escapes into the stylesheet: `;` starts a new
 * declaration, `}` closes the rule and lets the next characters open one of
 * their own. The rest are the ways a value reaches outside the document -
 * `@import` and `url()` fetch over the network, `<` closes an inline `<style>`
 * element, `\` hides any of the above behind a CSS escape, and a comment
 * marker lets a value swallow the declarations after it.
 *
 * `url()` and `image-set()` are two spellings of one problem and share a code.
 */
const FORBIDDEN_IN_VALUE: {
  pattern: RegExp;
  code: TokenValueProblemCode;
  reason: string;
}[] = [
  {
    pattern: /[;{}]/,
    code: "semicolon-or-brace",
    reason: "may not contain ; { or }",
  },
  { pattern: /[<>]/, code: "angle-bracket", reason: "may not contain < or >" },
  {
    pattern: /\\/,
    code: "backslash-escape",
    reason: "may not contain a backslash escape",
  },
  { pattern: /@/, code: "at-rule", reason: "may not contain an at-rule" },
  {
    pattern: /\/\*|\*\//,
    code: "comment-marker",
    reason: "may not contain a comment marker",
  },
  { pattern: /url\s*\(/i, code: "url", reason: "may not load a URL" },
  { pattern: /image-set\s*\(/i, code: "url", reason: "may not load a URL" },
  {
    pattern: /expression\s*\(/i,
    code: "expression",
    reason: "may not contain an expression()",
  },
];

/**
 * The single scan behind both exported forms.
 *
 * One walk rather than two, so the code an installer reports and the prose an
 * error carries can never name different problems for the same value - which
 * they could if two scans checked the same rules in two orders.
 */
function findTokenValueProblem(
  value: string,
): { code: TokenValueProblemCode; reason: string } | null {
  for (const { pattern, code, reason } of FORBIDDEN_IN_VALUE) {
    if (pattern.test(value)) {
      return { code, reason };
    }
  }
  // Checked by code point rather than by a character class, which lints as a
  // control-character regex. A newline or a NUL would let a value continue on
  // a line of its own.
  for (const char of value) {
    const point = char.codePointAt(0) ?? 0;
    if (point < 0x20 || point === 0x7f) {
      return {
        code: "control-character",
        reason: "may not contain a control character",
      };
    }
  }
  // A lone quote or paren would swallow everything after it, including the
  // closing brace, which has the same effect as writing one.
  if (countOf(value, "'") % 2 !== 0 || countOf(value, '"') % 2 !== 0) {
    return { code: "unbalanced-quote", reason: "has an unbalanced quote" };
  }
  if (countOf(value, "(") !== countOf(value, ")")) {
    return {
      code: "unbalanced-parenthesis",
      reason: "has an unbalanced parenthesis",
    };
  }
  return null;
}

/**
 * True when a value is safe to emit inside a declaration block.
 *
 * Exported because a theme installer wants to report every bad value at once
 * rather than discover them one thrown error at a time.
 *
 * The English prose is for a developer reading a TokenValueError. Anything
 * that has to reach a board member uses tokenValueProblemCode instead.
 */
export function tokenValueProblem(value: string): string | null {
  return findTokenValueProblem(value)?.reason ?? null;
}

/**
 * The same answer as a code, for anything that has to be read in a language
 * this package does not speak.
 */
export function tokenValueProblemCode(
  value: string,
): TokenValueProblemCode | null {
  return findTokenValueProblem(value)?.code ?? null;
}

function countOf(value: string, character: string): number {
  let count = 0;
  for (const char of value) {
    if (char === character) {
      count += 1;
    }
  }
  return count;
}

/**
 * Renders a token set as CSS custom property declarations.
 *
 * Values are validated rather than trusted. This is an exported boundary: a
 * theme is third-party content, and a value carrying `;` and `}` would close
 * the declaration and the rule and then write CSS of its own - including rules
 * that fetch over the network. Refusing is the right answer rather than
 * escaping, because no legitimate token value needs any of it.
 *
 * Takes a partial set: an override block states only the tokens it changes, and
 * the body has always emitted exactly the entries it was given. A full TokenSet
 * still satisfies this, and buildThemeStylesheet below still demands one, so
 * the generated default stylesheet cannot become incomplete.
 */
export function tokensToCssDeclarations(tokens: PartialTokenSet): string {
  const offending: { token: string; reason: string }[] = [];

  const declarations = Object.entries(tokens).flatMap(([name, value]) => {
    if (value === undefined) {
      return [];
    }
    const problem = tokenValueProblem(value);
    if (problem !== null) {
      offending.push({ token: name, reason: problem });
    }
    return [`  ${cssVariableName(name as TokenName)}: ${value};`];
  });

  if (offending.length > 0) {
    throw new TokenValueError(offending);
  }

  return declarations.join("\n");
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

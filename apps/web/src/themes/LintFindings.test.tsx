import {
  BUILT_IN_THEME,
  chainEntryFor,
  lintTheme,
  parseThemeManifest,
  resolveThemeChain,
} from "@openbrf/theme-tools";
import {
  TOKEN_VALUE_PROBLEM_CODES,
  type TokenValueProblemCode,
} from "@openbrf/tokens";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import type { ThemeLintFinding } from "../api/themes";
import i18n from "../i18n";
import { LintFindings } from "./LintFindings";

/**
 * A refusal, read in the reader's own language.
 *
 * A board member installing a theme is told why it was refused, and the value
 * check has more to say than the other rules: which of ten ways the value could
 * have written CSS of its own. That reason is produced by a package that speaks
 * only English, so it travels as a code and becomes a sentence here. Half a
 * sentence in English is not something a Swedish board can act on, so every
 * code is asserted end to end: from the lint that refused the theme to the
 * words on the screen.
 */

const LANGUAGES = ["sv", "en"] as const;
type Language = (typeof LANGUAGES)[number];

const TOKEN = "accent-trust";

/** A value that trips exactly one of the contract's checks. */
const VALUE_FOR: Readonly<Record<TokenValueProblemCode, string>> = {
  "semicolon-or-brace": "#fff; } :root { display: none",
  "angle-bracket": "</style><script>alert(1)</script>",
  "backslash-escape": "\\3b color:red",
  "at-rule": "@import",
  "comment-marker": "red /* swallow the rest",
  url: "url(https://tracker.example.com/x.png)",
  expression: "expression(alert(1))",
  "control-character": "red\nblue",
  "unbalanced-quote": "'unclosed",
  "unbalanced-parenthesis": "rgba(0, 0, 0",
};

/** The frame each language's sentences are built on. */
const FRAME: Readonly<Record<Language, RegExp>> = {
  sv: new RegExp(`^Värdet för ${TOKEN} i läget light `),
  en: new RegExp(`^The value of ${TOKEN} in light mode `),
};

/**
 * Words that would only appear if the other language's text had leaked in.
 *
 * The English list is the prose the token contract throws at a developer. It is
 * correct where it is thrown and wrong on this screen.
 */
const FOREIGN: Readonly<Record<Language, RegExp>> = {
  sv: /may not |unbalanced |an at-rule|comment marker|load a URL|has a /,
  en: /Värdet|läget|innehåller|vilket|skulle/,
};

/**
 * The refusal the real lint gives for that value.
 *
 * Linted rather than assembled by hand, so what is rendered is the detail an
 * install actually produces. A finding written out in the test would keep
 * passing if the lint went back to putting English prose in it.
 */
function refusalFor(code: TokenValueProblemCode): ThemeLintFinding {
  const parsed = parseThemeManifest(
    JSON.stringify({
      name: "example-theme",
      displayName: "Example",
      version: "1.0.0",
      contract: "^1.0.0",
      extends: BUILT_IN_THEME.id,
      modes: { light: { [TOKEN]: VALUE_FOR[code] }, dark: {} },
    }),
  );
  if (!parsed.ok) {
    throw new Error(`Test manifest is invalid: ${parsed.issues.join(", ")}`);
  }

  const entries = [BUILT_IN_THEME, chainEntryFor(parsed.manifest)];
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const result = lintTheme({
    manifest: parsed.manifest,
    files: ["theme.json"],
    chain: resolveThemeChain(parsed.manifest.name, (id) => byId.get(id)),
  });

  const finding = result.findings.find(
    (candidate) => candidate.rule === "unsafe-token-value",
  );
  if (finding === undefined) {
    throw new Error(`The lint did not refuse the ${code} value.`);
  }
  return finding;
}

async function sentenceFor(
  language: Language,
  finding: ThemeLintFinding,
): Promise<string> {
  await i18n.changeLanguage(language);
  render(<LintFindings findings={[finding]} />);
  const sentence = screen.getByRole("listitem").textContent ?? "";
  cleanup();
  return sentence;
}

/** What a problem this build has no sentence for falls back to. */
function unknownSentence(language: Language): Promise<string> {
  return sentenceFor(language, {
    rule: "unsafe-token-value",
    severity: "error",
    detail: { mode: "light", token: TOKEN, problem: "not-a-known-problem" },
  });
}

afterEach(async () => {
  cleanup();
  await i18n.changeLanguage("sv");
});

describe.each(LANGUAGES)("a refused value, read in %s", (language) => {
  it.each([...TOKEN_VALUE_PROBLEM_CODES])(
    "says in one language what %s means",
    async (code) => {
      const sentence = await sentenceFor(language, refusalFor(code));

      // A whole sentence, in one language, naming the token and the mode.
      expect(sentence).toMatch(FRAME[language]);
      expect(sentence).not.toMatch(FOREIGN[language]);
      expect(sentence.endsWith(".")).toBe(true);
      // No interpolation left standing where a value should have gone.
      expect(sentence).not.toContain("{{");

      // The reason itself, not the sentence that stops short of it.
      expect(sentence).not.toBe(await unknownSentence(language));
    },
  );

  it("gives each problem a sentence of its own", async () => {
    const sentences: string[] = [];
    for (const code of TOKEN_VALUE_PROBLEM_CODES) {
      sentences.push(await sentenceFor(language, refusalFor(code)));
    }

    // Ten distinct reasons. Collapsing them onto one sentence would mean the
    // reason had stopped reaching the reader, in whatever language.
    expect(new Set(sentences).size).toBe(TOKEN_VALUE_PROBLEM_CODES.length);
  });

  it("still answers in words when the problem is one it has never heard of", async () => {
    // An interface can be older than the core that refused the theme. Naming
    // the token and the mode and stopping there is a worse sentence than the
    // right one, and a far better one than a bare code.
    const sentence = await unknownSentence(language);

    expect(sentence).toMatch(FRAME[language]);
    expect(sentence).not.toContain("not-a-known-problem");
    expect(sentence).not.toMatch(FOREIGN[language]);
  });
});

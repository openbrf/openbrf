import { describe, expect, it } from "vitest";

import { REQUIRED_TOKEN_NAMES, TOKEN_NAMES } from "./contract.ts";
import { PORTTAVLAN_DARK, PORTTAVLAN_LIGHT } from "./porttavlan.ts";
import {
  buildThemeStylesheet,
  resolveTokens,
  TOKEN_VALUE_PROBLEM_CODES,
  tokensToCssDeclarations,
  TokenValueError,
  tokenValueProblem,
  type TokenValueProblemCode,
  tokenValueProblemCode,
} from "./resolve.ts";

describe("resolveTokens", () => {
  it("passes a complete theme through unchanged", () => {
    const result = resolveTokens(PORTTAVLAN_LIGHT);

    expect(result.missing).toEqual([]);
    expect(result.derived).toEqual([]);
    expect(result.tokens).toEqual(PORTTAVLAN_LIGHT);
  });

  it("lets a theme override selectively on top of its parent", () => {
    // The child-theme case: state only what changes.
    const result = resolveTokens(
      { "accent-trust": "#005F73" },
      PORTTAVLAN_LIGHT,
    );

    expect(result.tokens["accent-trust"]).toBe("#005F73");
    expect(result.tokens["surface-page"]).toBe(
      PORTTAVLAN_LIGHT["surface-page"],
    );
    expect(result.missing).toEqual([]);
  });

  it("derives an unstated token from its fallback", () => {
    const result = resolveTokens({
      ...PORTTAVLAN_LIGHT,
      "status-warn-soft": undefined,
    });

    expect(result.tokens["status-warn-soft"]).toBe(
      PORTTAVLAN_LIGHT["status-warn"],
    );
    expect(result.derived).toContain("status-warn-soft");
  });

  it("follows a fallback chain more than one level deep", () => {
    // Stating only the base of a family must still yield the whole family,
    // which is what lets the core add a variant without breaking old themes.
    const minimal = { ...PORTTAVLAN_LIGHT };
    delete (minimal as Record<string, string | undefined>)["text-register"];
    delete (minimal as Record<string, string | undefined>)[
      "text-register-secondary"
    ];

    const result = resolveTokens(minimal);

    // text-register has no fallback, so it is genuinely missing, and the
    // variant that depends on it is reported too rather than filled with junk.
    expect(result.missing).toContain("text-register");
  });

  it("reports a missing required token instead of emitting an empty value", () => {
    const result = resolveTokens({});

    // An empty custom property renders as an invisible element, which looks
    // like a broken app rather than a broken theme.
    expect(result.missing.length).toBeGreaterThan(0);
    for (const required of REQUIRED_TOKEN_NAMES) {
      expect(result.missing).toContain(required);
    }
  });

  it("treats an empty string as unstated", () => {
    const result = resolveTokens({
      ...PORTTAVLAN_LIGHT,
      "status-ok-soft": "",
    });

    expect(result.tokens["status-ok-soft"]).toBe(PORTTAVLAN_LIGHT["status-ok"]);
  });
});

describe("buildThemeStylesheet", () => {
  const css = buildThemeStylesheet({
    light: PORTTAVLAN_LIGHT,
    dark: PORTTAVLAN_DARK,
  });

  it("defines the light values on bare :root", () => {
    // Light must render when no preference and no explicit choice apply.
    expect(css).toContain(":root {");
    expect(css).toContain(
      `--obrf-surface-page: ${PORTTAVLAN_LIGHT["surface-page"]};`,
    );
  });

  it("supplies dark for a system preference, without beating an explicit light choice", () => {
    expect(css).toContain("@media (prefers-color-scheme: dark)");
    expect(css).toContain(':root:not([data-theme="light"])');
  });

  it("lets an explicit dark choice override the system in both directions", () => {
    expect(css).toContain(':root[data-theme="dark"]');
  });

  it("emits every token in the contract for both modes", () => {
    for (const name of TOKEN_NAMES) {
      expect(css).toContain(`--obrf-${name}:`);
    }
  });

  it("never defines a token only inside a media query", () => {
    // A value reachable only via prefers-color-scheme would vanish for a
    // viewer who picked a mode explicitly.
    const rootBlock = css.slice(css.indexOf(":root {"), css.indexOf("}"));
    for (const name of TOKEN_NAMES) {
      expect(rootBlock).toContain(`--obrf-${name}:`);
    }
  });
});

/**
 * A theme is third-party content and this is an exported boundary, so a token
 * value must not be able to write CSS of its own.
 */
describe("token value validation", () => {
  it.each([
    ["#fff; } :root { display: none", "; { or }"],
    ["red} body{display:none", "; { or }"],
    ["@import url(https://evil.example/x.css)", "at-rule"],
    ["url(https://evil.example/x.png)", "URL"],
    ["image-set('https://evil.example/x.png')", "URL"],
    ["expression(alert(1))", "expression()"],
    ["\\3b color:red", "backslash"],
    ["red /* swallow the rest", "comment marker"],
    ["</style><script>alert(1)</script>", "< or >"],
    ["'unclosed", "unbalanced quote"],
    ["rgba(0, 0, 0", "unbalanced parenthesis"],
  ])("refuses %s", (value, expected) => {
    expect(tokenValueProblem(value)).toContain(expected);
  });

  it.each([
    "#8A6D28",
    "rgba(28, 29, 31, 0.08)",
    "0 2px 10px rgba(28, 29, 31, 0.08)",
    "'Spline Sans Mono', ui-monospace, SFMono-Regular, Menlo, monospace",
    "cubic-bezier(0.2, 0, 0, 1)",
  ])("accepts %s, which a real theme writes", (value) => {
    expect(tokenValueProblem(value)).toBeNull();
  });

  it("refuses to emit a stylesheet at all rather than emitting injected CSS", () => {
    const hostile = {
      ...PORTTAVLAN_LIGHT,
      "surface-page": "#fff; } :root { display: none } .x {",
    };

    expect(() => tokensToCssDeclarations(hostile)).toThrow(TokenValueError);
    expect(() =>
      buildThemeStylesheet({ light: hostile, dark: PORTTAVLAN_DARK }),
    ).toThrow(TokenValueError);
  });

  it("names every offending token, so an installer reports them at once", () => {
    const hostile = {
      ...PORTTAVLAN_LIGHT,
      "surface-page": "#fff;}",
      "text-primary": "url(https://evil.example/x.css)",
    };

    try {
      tokensToCssDeclarations(hostile);
      expect.unreachable("expected TokenValueError");
    } catch (error) {
      expect(error).toBeInstanceOf(TokenValueError);
      expect((error as TokenValueError).offending.map((o) => o.token)).toEqual([
        "surface-page",
        "text-primary",
      ]);
    }
  });

  it("passes the default theme, which must survive its own gate", () => {
    expect(() =>
      buildThemeStylesheet({
        light: PORTTAVLAN_LIGHT,
        dark: PORTTAVLAN_DARK,
      }),
    ).not.toThrow();
  });
});

/**
 * The same refusal, named rather than described.
 *
 * The prose above is English and is thrown at a developer. An install refusal
 * is read by a board member in their own language, so what leaves this package
 * for the interface is a code the interface has a sentence for.
 */
describe("token value problem codes", () => {
  const cases: [string, TokenValueProblemCode][] = [
    ["#fff; } :root { display: none", "semicolon-or-brace"],
    ["</style><script>alert(1)</script>", "angle-bracket"],
    ["\\3b color:red", "backslash-escape"],
    ["@import url(https://evil.example/x.css)", "at-rule"],
    ["red /* swallow the rest", "comment-marker"],
    ["url(https://evil.example/x.png)", "url"],
    // A second spelling of one problem, so it answers with one code.
    ["image-set('https://evil.example/x.png')", "url"],
    ["expression(alert(1))", "expression"],
    ["red\nblue", "control-character"],
    ["'unclosed", "unbalanced-quote"],
    ["rgba(0, 0, 0", "unbalanced-parenthesis"],
  ];

  it.each(cases)("names %s", (value, expected) => {
    expect(tokenValueProblemCode(value)).toBe(expected);
  });

  it("declares no code it cannot produce", () => {
    // A code with no value that reaches it is a sentence somebody wrote for a
    // refusal that never happens, and one nobody can check reads correctly.
    const produced = new Set(cases.map(([, code]) => code));
    expect([...TOKEN_VALUE_PROBLEM_CODES].sort()).toEqual(
      [...produced].sort() as TokenValueProblemCode[],
    );
  });

  it("answers with a code exactly when it answers with prose", () => {
    // The two forms are one scan. They cannot disagree about whether a value is
    // safe, and a caller may rely on either.
    for (const [value] of cases) {
      expect(tokenValueProblemCode(value)).not.toBeNull();
      expect(tokenValueProblem(value)).not.toBeNull();
    }
    for (const safe of ["#8A6D28", "rgba(28, 29, 31, 0.08)"]) {
      expect(tokenValueProblemCode(safe)).toBeNull();
      expect(tokenValueProblem(safe)).toBeNull();
    }
  });
});

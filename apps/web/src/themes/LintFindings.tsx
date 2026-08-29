import {
  TOKEN_VALUE_PROBLEM_CODES,
  type TokenValueProblemCode,
} from "@openbrf/tokens";
import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";

import type { ThemeLintFinding } from "../api/themes";
import type { TranslationKey } from "../i18n/translation-key";

/**
 * Why the install lint refused a theme, in sentences a board can act on.
 *
 * The lint answers with rule codes and measured numbers rather than prose,
 * because the interface is Swedish by default and the packages that produce
 * the findings are English. Translating here is what turns "contrast" plus a
 * ratio into a sentence naming the pair, the mode and whether the pair is one
 * the statutory register is read on.
 *
 * A rule this build does not recognise still renders: a theme package can be
 * newer than the interface reading it, and "something was refused, and here is
 * its code" beats an empty box.
 */

const RULE_KEYS: Readonly<Record<string, TranslationKey>> = {
  "reserved-id": "themeCatalog.lint.reservedId",
  "self-extends": "themeCatalog.lint.selfExtends",
  "contract-incompatible": "themeCatalog.lint.contractIncompatible",
  "missing-parent": "themeCatalog.lint.missingParent",
  "inheritance-cycle": "themeCatalog.lint.inheritanceCycle",
  "unknown-manifest-field": "themeCatalog.lint.unknownManifestField",
  "unknown-token": "themeCatalog.lint.unknownToken",
  "missing-token": "themeCatalog.lint.missingToken",
  // unsafe-token-value is absent on purpose: its sentence is chosen by the
  // problem the value hit, not by the rule alone. See unsafeValueKey.
  contrast: "themeCatalog.lint.contrast",
  "executable-content": "themeCatalog.lint.executableContent",
  "unexpected-file": "themeCatalog.lint.unexpectedFile",
  "font-remote-source": "themeCatalog.lint.fontRemoteSource",
  "font-file-missing": "themeCatalog.lint.fontFileMissing",
  "font-file-undeclared": "themeCatalog.lint.fontFileUndeclared",
  "font-format": "themeCatalog.lint.fontFormat",
  "font-license-missing": "themeCatalog.lint.fontLicenseMissing",
  "license-file-missing": "themeCatalog.lint.licenseFileMissing",
  "logo-missing": "themeCatalog.lint.logoMissing",
  "unknown-view-variant": "themeCatalog.lint.unknownViewVariant",
  // Not a lint rule: the themes that block a removal arrive in the same shape,
  // because a refusal's particulars travel as a code and its detail whatever
  // produced them.
  "theme-has-dependants": "themeCatalog.lint.themeHasDependants",
};

/**
 * The sentence each unsafe-value problem is read as.
 *
 * Typed against the contract's own union rather than against string, so a
 * problem added to the token contract fails to compile here until somebody has
 * written the sentence for it. That is the difference between a board member
 * always getting a sentence and usually getting one.
 */
const UNSAFE_VALUE_KEYS: Readonly<
  Record<TokenValueProblemCode, TranslationKey>
> = {
  "semicolon-or-brace": "themeCatalog.lint.unsafeTokenValue.semicolonOrBrace",
  "angle-bracket": "themeCatalog.lint.unsafeTokenValue.angleBracket",
  "backslash-escape": "themeCatalog.lint.unsafeTokenValue.backslashEscape",
  "at-rule": "themeCatalog.lint.unsafeTokenValue.atRule",
  "comment-marker": "themeCatalog.lint.unsafeTokenValue.commentMarker",
  url: "themeCatalog.lint.unsafeTokenValue.url",
  expression: "themeCatalog.lint.unsafeTokenValue.expression",
  "control-character": "themeCatalog.lint.unsafeTokenValue.controlCharacter",
  "unbalanced-quote": "themeCatalog.lint.unsafeTokenValue.unbalancedQuote",
  "unbalanced-parenthesis":
    "themeCatalog.lint.unsafeTokenValue.unbalancedParenthesis",
};

/**
 * The key an unsafe value is read through.
 *
 * A problem code an older interface has never heard of still yields a whole
 * sentence: one that names the token and the mode and stops short of the
 * reason. Showing the code itself would be showing a board member a word from
 * a language nobody wrote for them.
 */
function unsafeValueKey(problem: unknown): TranslationKey {
  for (const code of TOKEN_VALUE_PROBLEM_CODES) {
    if (problem === code) {
      return UNSAFE_VALUE_KEYS[code];
    }
  }
  return "themeCatalog.lint.unsafeTokenValue.unknown";
}

function keyFor(finding: ThemeLintFinding): TranslationKey | undefined {
  return finding.rule === "unsafe-token-value"
    ? unsafeValueKey(finding.detail["problem"])
    : RULE_KEYS[finding.rule];
}

export function LintFindings({
  findings,
}: {
  findings: readonly ThemeLintFinding[];
}): ReactElement | null {
  const { t } = useTranslation();

  if (findings.length === 0) {
    return null;
  }

  return (
    <ul className="flex flex-col gap-1">
      {findings.map((finding, index) => {
        const key = keyFor(finding);
        const ratio = finding.detail["ratio"];

        return (
          <li
            key={`${finding.rule}-${String(index)}`}
            className="font-data text-data"
          >
            {key === undefined
              ? t("themeCatalog.lint.unrecognised", { rule: finding.rule })
              : t(key, {
                  ...finding.detail,
                  // Measured ratios read as 3.21, not 3.2100000000000004. A
                  // ratio of -1 is the lint's way of saying the colour could
                  // not be read at all.
                  ratio:
                    typeof ratio === "number" && ratio >= 0
                      ? ratio.toFixed(2)
                      : "?",
                })}
            {typeof finding.detail["theme"] === "string"
              ? ` ${t("themeCatalog.lint.inDescendant", {
                  theme: finding.detail["theme"],
                })}`
              : ""}
            {finding.detail["statutory"] === true
              ? ` ${t("themeCatalog.lint.statutory")}`
              : ""}
          </li>
        );
      })}
    </ul>
  );
}

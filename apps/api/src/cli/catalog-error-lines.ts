import type { CatalogRefusal, CatalogRefusalCode } from "@openbrf/plugin-sdk";
import type { TFunction } from "i18next";

import type { CatalogError } from "../packaging/catalog-entry";
import {
  permissionLabelKey,
  personalDataLabelKey,
} from "../plugins/plugin-labels";
import { terminalText } from "./terminal-text";

/** The catalog screen's sentence for each reason an index was not read. */
const CATALOG_ERROR_LABEL_KEYS: Readonly<
  Record<CatalogError["reason"], string>
> = {
  "catalog-unreachable": "plugins.catalog.errors.unreachable",
  "catalog-malformed": "plugins.catalog.errors.malformed",
  "catalog-source-not-permitted": "plugins.catalog.errors.notPermitted",
};

/**
 * The sentence for each refusal of an index that holds one entry against
 * another. Keyed by the SDK's union, so a refusal added there without its
 * sentence fails the build here.
 */
const CATALOG_REFUSAL_LABEL_KEYS: Readonly<Record<CatalogRefusalCode, string>> =
  {
    "extension-point-unknown": "plugins.catalog.refusals.extensionPointUnknown",
    "extension-version-unsupported":
      "plugins.catalog.refusals.extensionVersionUnsupported",
    "extension-personal-data-refused":
      "plugins.catalog.refusals.extensionPersonalDataRefused",
    "extension-permission-refused":
      "plugins.catalog.refusals.extensionPermissionRefused",
    "extension-host-personal-data-refused":
      "plugins.catalog.refusals.extensionHostPersonalDataRefused",
    "extension-group-refused": "plugins.catalog.refusals.extensionGroupRefused",
  };

/** The lists in a refusal whose members are codes with sentences of their own. */
const LIST_LABELS: Readonly<Record<string, (code: string) => string>> = {
  permissions: permissionLabelKey,
  categories: personalDataLabelKey,
};

/**
 * Why the catalog could not be read, as the catalog screen says it, and what
 * was thrown beneath it.
 *
 * An index refused for an addon its host plugin cannot serve, or for the
 * plugins joined to it, gives that refusal in a sentence of its own, with the
 * line the curator fixes the index from beneath it. A field's own problem is
 * that line alone.
 *
 * Every line is made safe for the terminal: the catalog chose the ids and
 * fields it quotes.
 */
export function catalogErrorLines(error: CatalogError, t: TFunction): string[] {
  const lines = [terminalText(t(CATALOG_ERROR_LABEL_KEYS[error.reason]))];
  if (error.diagnostics.length === 0) {
    return [...lines, `  ${terminalText(error.message)}`];
  }
  for (const { issue, refusal } of error.diagnostics) {
    if (refusal === null) {
      lines.push(`  ${terminalText(issue)}`);
      continue;
    }
    lines.push(
      `  ${terminalText(t(CATALOG_REFUSAL_LABEL_KEYS[refusal.code], refusalValues(refusal, t)))}`,
      `    ${terminalText(issue)}`,
    );
  }
  return lines;
}

/** The refusal's detail, with every list of codes read as its sentences. */
function refusalValues(
  refusal: CatalogRefusal,
  t: TFunction,
): Record<string, string | number> {
  const values: Record<string, string | number> = {};
  for (const [name, value] of Object.entries(refusal.detail)) {
    if (typeof value !== "object") {
      values[name] = value;
      continue;
    }
    const label = LIST_LABELS[name];
    values[name] =
      label === undefined
        ? value.join(", ")
        : value.map((code) => t(label(code))).join("; ");
  }
  return values;
}

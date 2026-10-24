import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { type Locale, SUPPORTED_LOCALES } from "../i18n/i18n.service";
import { dataPaths } from "../packaging/data-paths";
import { pluginModulesDirectory } from "./plugin-directory";

/** A plugin's locale files, by locale, as far as they could be read. */
export type PluginLocales = Partial<Record<Locale, Record<string, unknown>>>;

/**
 * Reads the locale files of a plugin package, `locales/<locale>.json`.
 *
 * Data, never code: the boot reads them for a plugin it loads, and the access
 * report for a plugin whose records it prints, running or not (ADR 0047). A
 * file that is absent or not a JSON object is left out, and the caller decides
 * what a missing label reads as.
 */
export async function readPluginLocales(
  directory: string,
): Promise<PluginLocales> {
  const resources: PluginLocales = {};
  for (const locale of SUPPORTED_LOCALES) {
    const path = join(directory, "locales", `${locale}.json`);
    try {
      const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        !Array.isArray(parsed)
      ) {
        resources[locale] = parsed as Record<string, unknown>;
      }
    } catch {
      // No file for this locale, or it is not JSON.
    }
  }
  return resources;
}

/**
 * Where the consented package of an installed plugin lives on the volume: the
 * directory `isConsentedPackage` holds a discovered package to.
 */
export function installedPackageDirectory(
  dataDir: string,
  packageName: string,
): string {
  return join(pluginModulesDirectory(dataPaths(dataDir).plugins), packageName);
}

/**
 * The text a key names in a plugin's locale file, for one locale, or null.
 *
 * A key is dotted, as i18next reads it: `records.claims.title` is the value at
 * that path of nested objects, or a flat key spelled with the dots. Only a
 * string is text.
 */
export function pluginText(
  locales: PluginLocales,
  locale: Locale,
  key: string,
): string | null {
  const bundle = locales[locale];
  if (bundle === undefined) {
    return null;
  }
  const flat = bundle[key];
  if (typeof flat === "string") {
    return flat;
  }
  let node: unknown = bundle;
  for (const part of key.split(".")) {
    if (typeof node !== "object" || node === null || Array.isArray(node)) {
      return null;
    }
    node = Object.prototype.hasOwnProperty.call(node, part)
      ? (node as Record<string, unknown>)[part]
      : undefined;
  }
  return typeof node === "string" ? node : null;
}

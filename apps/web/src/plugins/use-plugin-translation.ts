import { useCallback } from "react";
import { useTranslation } from "react-i18next";

import { pluginNamespace } from "./plugin-i18n";

/** Translates a key in one plugin's own namespace. */
export type PluginTranslator = (key: string) => string;

/**
 * A translator for a plugin's strings.
 *
 * The core's keys are checked against en.json at compile time, and a plugin's
 * cannot be: they exist only in a locale file on the data volume, put there by
 * an install that happened long after this application was built. So this is
 * the one place where a key is a plain string, and the fallback for a missing
 * one is i18next's own - it renders the key, which is visibly wrong rather
 * than silently blank.
 */
export function usePluginTranslation(pluginId: string): PluginTranslator {
  const { i18n } = useTranslation();
  const namespace = pluginNamespace(pluginId);

  return useCallback(
    (key: string) => {
      // The single cast this file exists to contain: i18next's t is typed for
      // the namespaces known at build time, and a plugin's is not one of them.
      const translate = i18n.t as unknown as (
        key: string,
        options: { ns: string },
      ) => string;
      return translate(key, { ns: namespace });
    },
    [i18n, namespace],
  );
}

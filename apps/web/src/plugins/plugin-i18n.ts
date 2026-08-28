import { apiRequest } from "../api/client";
import i18n from "../i18n";

/** The locales the product ships. Mirrors SUPPORTED_LOCALES on the server. */
const LOCALES = ["sv", "en"] as const;

/** The i18next namespace a plugin's own strings live under. */
export function pluginNamespace(pluginId: string): string {
  return `plugin-${pluginId}`;
}

/**
 * Loads a plugin's translations into the running i18next instance.
 *
 * A plugin's strings cannot be bundled: the whole point of the system is that
 * a plugin appears without the application being rebuilt, so its locale files
 * only exist on the server's data volume. They are fetched lazily, per
 * namespace, from the endpoint that serves exactly the bundle the server
 * merged (plan section 7).
 *
 * Both locales are fetched rather than only the active one. The instance's own
 * default language and the signed-in person's may differ, and a language
 * switch that leaves a plugin's labels showing as raw keys until a reload is
 * worse than one extra small request.
 *
 * Failures are swallowed on purpose. i18next falls back to the key, which is a
 * visibly wrong label; a thrown error here would instead take down the screen
 * the plugin is only a part of.
 */
export async function loadPluginTranslations(pluginId: string): Promise<void> {
  const namespace = pluginNamespace(pluginId);

  await Promise.all(
    LOCALES.map(async (locale) => {
      if (i18n.hasResourceBundle(locale, namespace)) {
        return;
      }
      const result = await apiRequest<Record<string, unknown>>(
        "GET",
        `/api/i18n/${locale}/${encodeURIComponent(namespace)}`,
      );
      if (result.ok) {
        // Deep merge, overwriting: a reinstall at a new version has to be able
        // to change a string rather than losing to the copy already in memory.
        i18n.addResourceBundle(locale, namespace, result.value, true, true);
      }
    }),
  );
}

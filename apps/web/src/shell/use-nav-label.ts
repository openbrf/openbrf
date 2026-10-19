import { useCallback } from "react";
import { useTranslation } from "react-i18next";

import { translatePluginKey } from "../plugins/use-plugin-translation";
import type { NavItem } from "./nav-items";

/**
 * The words a destination is shown under.
 *
 * A core destination's key is read in the application's own translations, and
 * a plugin's title in the plugin's namespace. A title whose locale file did
 * not load shows as its key, which is visibly wrong rather than blank, on the
 * rule the plugin's own screen follows.
 */
export function useNavLabel(): (item: NavItem) => string {
  const { t, i18n } = useTranslation();

  return useCallback(
    (item: NavItem) =>
      item.pluginId === undefined
        ? t(item.labelKey)
        : translatePluginKey(i18n, item.pluginId, item.labelKey),
    [t, i18n],
  );
}

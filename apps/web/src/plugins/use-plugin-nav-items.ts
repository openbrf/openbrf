import { useEffect, useState } from "react";

import { type NavItem, pluginNavItems } from "../shell/nav-items";
import { fetchPluginViews } from "./plugin-api";
import { loadPluginTranslations } from "./plugin-i18n";

/**
 * The navigation's entries for the plugin views this account is offered.
 *
 * Empty until the answer and the plugins' translations are in, so an entry
 * never appears under its raw key and then changes its name. Empty for good
 * when the list cannot be read: the core's destinations do not wait on, or
 * fail with, anything a plugin contributes.
 */
export function usePluginNavItems(): readonly NavItem[] {
  const [items, setItems] = useState<readonly NavItem[]>([]);

  useEffect(() => {
    let active = true;

    const load = async (): Promise<void> => {
      const result = await fetchPluginViews();
      if (!active || !result.ok) {
        return;
      }
      const offered = result.value.views.filter(
        (view) => view.section !== null,
      );
      await Promise.all(offered.map((view) => loadPluginTranslations(view.id)));
      if (active) {
        setItems(pluginNavItems(offered));
      }
    };

    void load();
    return () => {
      active = false;
    };
  }, []);

  return items;
}

import { loadRemote, registerRemotes } from "@module-federation/runtime";
import type { ComponentType } from "react";

import type { PluginViewDescriptor } from "./plugin-api";

/**
 * Loading a plugin's view at runtime.
 *
 * Module Federation 2.0 (ADR 0003). No remote is named at build time, because
 * which plugins an instance runs is not known then and not having to know is
 * the point: a plugin's view appears without the application being rebuilt.
 * The host's Vite config declares React, ReactDOM and i18next as shared
 * singletons, so a plugin's component renders against the same React that owns
 * the tree it is mounted in and reads the same i18next store its translations
 * were merged into.
 *
 * The remote entry is served from this application's own origin
 * (/api/plugins/<id>/client/...), behind the session, rather than from wherever
 * the plugin was published.
 */

const registered = new Set<string>();

/**
 * Registers a remote once.
 *
 * Registering the same name twice is not an error in the federation runtime,
 * but the second registration replaces the first, which would drop a
 * container that already has modules loaded from it.
 */
export function registerPluginRemote(view: PluginViewDescriptor): void {
  if (registered.has(view.id)) {
    return;
  }
  registerRemotes([
    {
      name: view.id,
      entry: view.remoteEntry,
      // Manifest resolution would mean a second request for a file the plugin
      // does not ship; the entry is the container itself.
      type: "module",
    },
  ]);
  registered.add(view.id);
}

/** What a plugin's exposed view module has to look like. */
type ViewModule = { default: ComponentType } | ComponentType;

/**
 * Loads one exposed component from a plugin.
 *
 * Returns null rather than throwing when the remote cannot be reached or does
 * not expose the module it declared: a plugin whose bundle is broken must
 * leave the rest of the screen working, which is the same rule the server-side
 * loader follows.
 */
export async function loadPluginView(
  view: PluginViewDescriptor,
): Promise<ComponentType | null> {
  registerPluginRemote(view);

  try {
    const loaded = await loadRemote<ViewModule>(
      `${view.id}/${stripDotSlash(view.module)}`,
    );
    if (loaded === null || loaded === undefined) {
      return null;
    }
    if (typeof loaded === "function") {
      return loaded;
    }
    return typeof loaded.default === "function" ? loaded.default : null;
  } catch {
    return null;
  }
}

/**
 * Module Federation exposes are declared as "./View" and requested as
 * "<remote>/View". One spelling in the manifest, one at the call site.
 */
function stripDotSlash(module: string): string {
  return module.startsWith("./") ? module.slice(2) : module;
}

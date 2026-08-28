import { resolve } from "node:path";

/**
 * Where installed packages live on the data volume.
 *
 * One place decides these names, because the loader, the installer, the CLI
 * and the theme engine all have to agree on them, and a second spelling of
 * "plugins" somewhere would produce an instance that installs into a directory
 * it never scans.
 */

export interface DataPaths {
  root: string;
  /** npm's installation root for plugins; node_modules sits inside it. */
  plugins: string;
  /** Verified tarballs, kept so a reinstall needs no network. */
  pluginArchives: string;
  /** Where an install is assembled before it is moved into place. */
  pluginStaging: string;
  themes: string;
}

export function dataPaths(dataDir: string): DataPaths {
  const root = resolve(dataDir);
  const plugins = resolve(root, "plugins");
  return {
    root,
    plugins,
    // Inside the plugins directory rather than beside it, so one volume mount
    // carries the archives that a reinstall needs together with the install
    // they belong to.
    pluginArchives: resolve(plugins, "archives"),
    pluginStaging: resolve(plugins, "staging"),
    themes: resolve(root, "themes"),
  };
}

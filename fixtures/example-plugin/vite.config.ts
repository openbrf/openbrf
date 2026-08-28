import { federation } from "@module-federation/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/**
 * The view's build.
 *
 * Standalone rather than part of the monorepo's build: a plugin is packaged and
 * installed exactly like a third-party one, so it has to be buildable by its own
 * toolchain with nothing borrowed from the application.
 *
 * React, ReactDOM, react-i18next and i18next are shared singletons, matching
 * the host's own list exactly. The host has already loaded all four, and a
 * second copy of any of them would give the view its own hook dispatcher and
 * its own resource store - the first breaks on the first hook call, the second
 * shows keys instead of Swedish, because a plugin's translations were merged
 * into the host's store and nowhere else. `requiredVersion: false`
 * because a plugin is installed into a host whose exact version it was not built
 * against, and refusing to share over a patch difference would leave it with the
 * duplicate copy the singleton exists to prevent.
 */
export default defineConfig({
  plugins: [
    react(),
    federation({
      // The remote's name is the plugin id, which is what the host looks it up
      // by in the manifest it already read.
      name: "occupancy",
      filename: "remoteEntry.js",
      exposes: { "./View": "./src/View.tsx" },
      shared: {
        react: { singleton: true, requiredVersion: false },
        "react-dom": { singleton: true, requiredVersion: false },
        "react-i18next": { singleton: true, requiredVersion: false },
        i18next: { singleton: true, requiredVersion: false },
      },
      // The federated type bundle is for a consumer that imports the remote at
      // its own build time. The host loads this one at runtime from a manifest,
      // so the archive would only be dead weight inside the tarball.
      dts: false,
    }),
  ],
  build: {
    target: "esnext",
    outDir: "dist",
    // The server bundle is emitted into the same directory by tsc.
    emptyOutDir: false,
    // A fixture is read as often as it is run.
    minify: false,
    // No input of its own: the remote entry is the only entry point, and the
    // federation plugin emits it. Left unset, Vite would look for the index.html
    // of an application this package is not.
    rollupOptions: { input: {} },
  },
});

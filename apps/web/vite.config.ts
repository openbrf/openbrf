import { federation } from "@module-federation/vite";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/** Where the API listens in development. Matches PORT in .env.example. */
const API_ORIGIN = process.env.OPENBRF_API_ORIGIN ?? "http://localhost:3000";

/**
 * Packages a plugin view must share with this application rather than bring
 * its own copy of.
 *
 * React holds the reconciler and the hook dispatcher in module state, so two
 * copies means a plugin's component renders against a React that knows nothing
 * about the tree it is mounted in - the failure is "invalid hook call", and it
 * appears only once a plugin is actually installed. i18next holds the merged
 * resource store, which is where a plugin's own translations were put at
 * runtime, so a second copy would leave its labels showing as keys.
 */
const SHARED_WITH_PLUGINS = {
  react: { singleton: true, requiredVersion: false },
  "react-dom": { singleton: true, requiredVersion: false },
  "react/jsx-runtime": { singleton: true, requiredVersion: false },
  i18next: { singleton: true, requiredVersion: false },
  "react-i18next": { singleton: true, requiredVersion: false },
} as const;

export default defineConfig({
  /*
   * The client is served under /app, not at the root.
   *
   * The root belongs to the association's own public website, which the API
   * renders. This is what puts the prefix on every built asset URL in
   * index.html, so a reload of a deep link resolves its scripts and styles;
   * the router is told the same prefix as its `basepath`, and the API serves
   * the built files from it. All three have to agree, and the end-to-end suite
   * is where they are held to it.
   */
  base: "/app/",

  /*
   * Module Federation 2.0, host side.
   *
   * No remotes are listed: which plugins an instance runs is not known at
   * build time, and not having to know is the entire point - a plugin view
   * appears without the application being rebuilt. Remotes are registered at
   * runtime from what the API reports (see src/plugins/plugin-remotes.ts).
   *
   * esnext because the federation runtime relies on top-level await.
   */
  build: { target: "esnext" },
  plugins: [
    react(),
    tailwindcss(),
    federation({
      name: "openbrf",
      remotes: {},
      shared: SHARED_WITH_PLUGINS,
    }),
  ],
  server: {
    port: 5173,
    /*
     * Proxy the API so the browser sees ONE origin in development.
     *
     * Sessions are http-only cookies. Served from two origins - the SPA on
     * 5173 and the API on 3000 - the browser treats every API call as
     * cross-site, so the session cookie is neither sent nor stored and sign-in
     * silently does nothing. Proxying makes development match production, where
     * the API serves the built SPA from its own origin, rather than papering
     * over the difference with permissive CORS.
     */
    proxy: {
      "/api": {
        target: API_ORIGIN,
        /*
         * Deliberately false, which is the opposite of most proxy examples.
         *
         * The API rebuilds each request's URL from the incoming Host header so
         * it sees the origin the browser actually used. Rewriting Host to the
         * target would make the auth layer believe the request came from
         * localhost:3000 while the browser sits on 5173, which breaks origin
         * validation and the cookie domain.
         */
        changeOrigin: false,
      },
    },
  },
});

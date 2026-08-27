import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/** Where the API listens in development. Matches PORT in .env.example. */
const API_ORIGIN = process.env.OPENBRF_API_ORIGIN ?? "http://localhost:3000";

export default defineConfig({
  plugins: [react(), tailwindcss()],
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

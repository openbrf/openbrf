import { passkeyClient } from "@better-auth/passkey/client";
import { createAuthClient } from "better-auth/react";
import { magicLinkClient, twoFactorClient } from "better-auth/client/plugins";

/**
 * The browser-side auth client.
 *
 * `baseURL` is deliberately omitted so every request is same-origin and
 * relative. In development a Vite proxy forwards /api to the API; in production
 * the API serves this bundle itself. Pointing the client at an absolute API
 * origin would make the browser treat sessions as cross-site and drop the
 * cookie, which is the failure this arrangement exists to avoid.
 *
 * `basePath` matches the API's own auth mount point.
 */
export const authClient = createAuthClient({
  basePath: "/api/auth",
  /*
   * Client plugins mirror the server's. Without the counterpart the method
   * simply is not on the client, so a missing plugin shows up as a type error
   * rather than a runtime surprise.
   *
   * The passkey plugin is a separate package since Better Auth 1.4, and it has
   * to run in the browser: creating a passkey calls the WebAuthn API on the
   * device, so no amount of server-side work can stand in for it. Signing in
   * with one is still not covered by tests - that needs a virtual authenticator
   * and the end-to-end suite - so the roadmap says so rather than implying it.
   */
  plugins: [magicLinkClient(), twoFactorClient(), passkeyClient()],
});

export const { signIn, signOut, useSession } = authClient;

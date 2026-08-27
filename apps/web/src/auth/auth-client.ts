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
   * Passkeys are not wired up here yet: the server accepts them, but there is
   * no enrolment surface until the security settings screen exists, and the
   * end-to-end suite that can drive a WebAuthn authenticator does not exist
   * either. The roadmap says so rather than implying coverage.
   */
  plugins: [magicLinkClient(), twoFactorClient()],
});

export const { signIn, signOut, useSession } = authClient;

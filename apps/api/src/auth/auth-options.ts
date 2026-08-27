import { passkey } from "@better-auth/passkey";
import type { BetterAuthOptions } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { APIError } from "better-auth/api";
import { magicLink } from "better-auth/plugins/magic-link";
import { twoFactor } from "better-auth/plugins/two-factor";

import type { Env } from "../config/env";
import type { PrismaService } from "../database/prisma.service";

/** How long a magic link stays valid, in seconds. */
const MAGIC_LINK_TTL_SECONDS = 15 * 60;

/** Sign-in attempts allowed per window, per IP. */
const RATE_LIMIT_MAX = 20;
const RATE_LIMIT_WINDOW_SECONDS = 60;

export interface MagicLinkDelivery {
  /**
   * Delivers a sign-in link. Implemented by AuthService against MailService so
   * this module stays free of transport concerns.
   */
  send: (input: {
    email: string;
    url: string;
    expiresAt: Date;
  }) => Promise<void>;
  /**
   * Whether the account for this address has TOTP enrolled. Used to enforce
   * the second-factor policy below.
   */
  hasSecondFactor: (email: string) => Promise<boolean>;
}

/**
 * Better Auth configuration.
 *
 * Four sign-in methods are enabled together: password, magic link, passkeys
 * and TOTP (decision 29).
 *
 * The second-factor policy is the subtle part. Better Auth's twoFactor plugin
 * gates the *password* sign-in flow: when a user has TOTP enrolled,
 * signIn.email returns a two-factor challenge instead of a session. Magic link
 * is a different endpoint that mints a session directly, so a TOTP-protected
 * account could be entered with mailbox access alone, walking straight around
 * the second factor. Phase 1 therefore refuses to issue a magic link to an
 * account that has TOTP enrolled, and says so, rather than silently handing
 * out a weaker path than the user asked for. Passkeys are left alone: they are
 * phishing-resistant and hardware-bound, so they are not a downgrade.
 *
 * Sign-up is disabled outright. Accounts come from an invitation or from a
 * board-approved self-signup request, both of which create the person first
 * (decision: invite-only plus approval). There is no open registration on an
 * instance holding a statutory register.
 */
export function buildAuthOptions(
  env: Env,
  prisma: PrismaService,
  magicLinkDelivery: MagicLinkDelivery,
) {
  // Deliberately `satisfies` rather than an annotated return type: the
  // additionalFields declaration below only reaches the typed API surface
  // (auth.api.signUpEmail and friends) if the literal type survives, and a
  // BetterAuthOptions annotation widens it away.
  return {
    appName: "Open BRF",
    secret: env.BETTER_AUTH_SECRET,
    baseURL: env.APP_URL,
    basePath: "/api/auth",

    database: prismaAdapter(prisma, { provider: "postgresql" }),

    emailAndPassword: {
      enabled: true,
      // No open registration: see the note above.
      disableSignUp: true,
      minPasswordLength: 12,
    },

    user: {
      additionalFields: {
        // Every account belongs to a person in the register.
        personId: {
          type: "string",
          required: true,
          input: true,
        },
      },
    },

    session: {
      expiresIn: 60 * 60 * 24 * 30,
      updateAge: 60 * 60 * 24,
    },

    advanced: {
      // The SPA is served from the same origin as the API, so a host-only
      // cookie is enough and avoids sharing the session with subdomains.
      useSecureCookies: env.NODE_ENV === "production",

      ipAddress: {
        // The deployment is a container behind a reverse proxy, so the client
        // address only survives in a forwarded header. Without this, Better
        // Auth cannot resolve a client IP and falls back to one shared
        // rate-limit bucket for the whole instance, where a single resident
        // failing to sign in would throttle the entire board.
        //
        // This assumes the proxy OVERWRITES x-forwarded-for rather than
        // appending to a client-supplied value, which is the default behaviour
        // of nginx, Caddy and Traefik. An instance exposed directly to the
        // internet without a proxy would let a caller spoof this header and
        // sidestep the rate limit.
        ipAddressHeaders: ["x-forwarded-for"],
      },
    },

    rateLimit: {
      enabled: true,
      window: RATE_LIMIT_WINDOW_SECONDS,
      max: RATE_LIMIT_MAX,
    },

    plugins: [
      twoFactor({
        issuer: "Open BRF",
      }),

      magicLink({
        expiresIn: MAGIC_LINK_TTL_SECONDS,
        sendMagicLink: async ({ email, url }) => {
          if (await magicLinkDelivery.hasSecondFactor(email)) {
            // Refuse rather than deliver a link that would bypass TOTP.
            throw new APIError("BAD_REQUEST", {
              message:
                "This account uses an authenticator app. Sign in with your password and code, or with a passkey.",
              code: "MAGIC_LINK_DISABLED_FOR_TWO_FACTOR",
            });
          }

          await magicLinkDelivery.send({
            email,
            url,
            expiresAt: new Date(Date.now() + MAGIC_LINK_TTL_SECONDS * 1000),
          });
        },
      }),

      passkey({
        rpName: "Open BRF",
      }),
    ],
  } satisfies BetterAuthOptions;
}

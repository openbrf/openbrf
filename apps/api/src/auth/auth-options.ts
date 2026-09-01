import { passkey } from "@better-auth/passkey";
import type { BetterAuthOptions } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { magicLink } from "better-auth/plugins/magic-link";
import { twoFactor } from "better-auth/plugins/two-factor";

import type { Env } from "../config/env";
import type { PrismaService } from "../database/prisma.service";

/** How long a magic link stays valid, in seconds. */
const MAGIC_LINK_TTL_SECONDS = 15 * 60;

/**
 * The default budget on an auth endpoint: what one client address may spend on
 * one path, and how long it then has to be quiet.
 *
 * Better Auth counts per address and per path, and the count only clears after
 * a whole window in which that address asked nothing on that path - every
 * request it allows moves the window forward. So the window is not a rate
 * window; it is how long a caller has to stop before the budget comes back.
 *
 * This is the floor rather than the credential defence. Better Auth applies
 * tighter rules of its own ahead of it, and every path where guessing is the
 * attack is covered by one: three attempts per ten seconds on /sign-in,
 * /sign-up, /change-password and /change-email, three per ten on /two-factor/*
 * from the plugin below, and five per minute on the magic link's two paths from
 * the plugin below that. Nothing here may loosen those.
 *
 * Exported, like deliverMagicLink below, so a suite can state a budget as the
 * relation it is - wider on one path, tighter on another - rather than
 * repeating a number that would then be free to drift away from this one.
 */
export const RATE_LIMIT_MAX = 20;
const RATE_LIMIT_WINDOW_SECONDS = 60;

/**
 * The session read's path, relative to `basePath` below.
 *
 * Spelled exactly, with no wildcard: a custom rule is matched after the tighter
 * rules above and replaces the one it matches, so a pattern reaching a
 * credential path would widen that path's defence. This one matches the session
 * read and nothing else. Better Auth compares the pathname alone, so the
 * client's query string does not have to be accounted for here.
 */
export const SESSION_READ_PATH = "/get-session";

/**
 * The session read's own budget, and why it is not the default above.
 *
 * This is the path the interface asks most and the one the application chooses
 * least about: a route guard reads the session before every guarded screen
 * renders, the client's session store reads it again when a page loads, and it
 * reads it once more each time the window regains focus. An interface in use
 * therefore produces a stream of them, a person with two tabs open produces two
 * streams, and none of that is a rate the application sets. Under the default
 * budget, about a dozen guarded navigations spend all twenty, and the
 * twenty-first read is answered 429 - which the client cannot tell apart from
 * having no session, so the screen returns to the sign-in form mid-session.
 *
 * Its own budget, because the two paths ask different questions. A sign-in is a
 * guess at a credential and worth counting tightly. A session read presents the
 * cookie the browser already holds and answers with the session or with null:
 * there is nothing in it to guess, and a budget on it changes what an attacker
 * gains by nothing at all. What it does bound is the cost of the read, which is
 * two indexed lookups - the same reasoning public-rate-limit.decorator.ts
 * states for why a signed-in GET is not what a submission budget is for.
 *
 * Ten seconds rather than sixty follows from the counting rule above: a person
 * who leaves a screen alone for ten seconds hands the budget back, where a
 * minute-long window means an interface in continuous use never gets one back.
 * Two hundred is what one address may spend inside a stretch with no such
 * pause, and one address is a household, an office or a whole building behind
 * one connection.
 */
export const SESSION_READ_MAX = 200;
export const SESSION_READ_WINDOW_SECONDS = 10;

export interface AccountState {
  /** Whether the register holds an account for this address at all. */
  exists: boolean;
  /** Whether that account has TOTP enrolled. False when it does not exist. */
  hasSecondFactor: boolean;
}

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
  /** What the register knows about an address. Drives the policy below. */
  accountState: (email: string) => Promise<AccountState>;
  /**
   * Tells the account holder why no link arrived. Delivered by mail rather
   * than in the HTTP response, so the refusal reaches the mailbox owner and
   * nobody else.
   */
  sendSecondFactorNotice: (input: { email: string }) => Promise<void>;
}

/**
 * Decides what an address actually receives when a sign-in link is requested.
 *
 * Three outcomes, one response. Better Auth answers `{ status: true }` no
 * matter which branch runs, because this endpoint is public and any visible
 * difference is an enumeration oracle against a statutory register.
 *
 *   No account: nothing is sent. The plugin calls this before it checks
 *   whether the user exists, so without this branch anyone could make the
 *   instance mail a sign-in link to an address of their choosing.
 *
 *   TOTP enrolled: an explanation is mailed instead of a link. Better Auth's
 *   second factor gates password sign-in only, so a magic link would mint a
 *   session with mailbox access alone.
 *
 *   Otherwise: the link.
 *
 * Exported so the policy is testable on its own, without standing up the
 * plugin to reach the callback.
 */
export async function deliverMagicLink(
  delivery: MagicLinkDelivery,
  input: { email: string; url: string; expiresAt: Date },
): Promise<void> {
  const account = await delivery.accountState(input.email);

  if (!account.exists) {
    return;
  }

  if (account.hasSecondFactor) {
    await delivery.sendSecondFactorNotice({ email: input.email });
    return;
  }

  await delivery.send(input);
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
 * account that has TOTP enrolled, rather than silently handing out a weaker
 * path than the user asked for. Passkeys are left alone: they are
 * phishing-resistant and hardware-bound, so they are not a downgrade.
 *
 * The refusal is explained by email and never in the response. This endpoint
 * is public, so an error naming the reason would confirm to any caller that
 * the address has an account and that the account has a second factor. On an
 * instance holding a statutory register that is an enumeration oracle, so
 * every address gets the same answer and only the mailbox owner learns more.
 * deliverMagicLink below is where that policy lives.
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

      // One entry, for the one path whose caller is the interface rather than
      // somebody trying credentials. Everything else keeps the default above,
      // and the credential paths keep the tighter rules Better Auth applies to
      // them - a custom rule replaces whichever rule it matches, so this map is
      // the one place from which the brute-force defence could be widened by
      // accident, and it names a single path so that it cannot be.
      customRules: {
        [SESSION_READ_PATH]: {
          window: SESSION_READ_WINDOW_SECONDS,
          max: SESSION_READ_MAX,
        },
      },
    },

    plugins: [
      twoFactor({
        issuer: "Open BRF",
      }),

      magicLink({
        expiresIn: MAGIC_LINK_TTL_SECONDS,
        // The plugin stores the token in plain text by default. A magic-link
        // token is a sign-in credential with the same standing as an
        // invitation token, and InvitationService stores those as a SHA-256
        // hash precisely so a leaked database yields nothing usable. The same
        // rule applies here: the plaintext exists only in the email.
        storeToken: "hashed",
        // Its own switch, separate from emailAndPassword.disableSignUp: this
        // plugin would otherwise create an account at verify time for any
        // address that followed a link, which is open registration by another
        // name on an invite-only instance.
        disableSignUp: true,
        sendMagicLink: async ({ email, url }) => {
          await deliverMagicLink(magicLinkDelivery, {
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

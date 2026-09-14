import { describe, expect, it } from "vitest";

import type { Env } from "../config/env";
import type { PrismaClient } from "../generated/prisma/client";
import type { PrismaService } from "../database/prisma.service";
import {
  type AccountState,
  buildAuthOptions,
  deliverMagicLink,
  type MagicLinkDelivery,
  RATE_LIMIT_MAX,
  SESSION_READ_MAX,
  SESSION_READ_PATH,
  SESSION_READ_WINDOW_SECONDS,
} from "./auth-options";
import { hashOpaqueToken } from "./opaque-token";

/**
 * One options object, built the way the application builds it, for every
 * assertion below that reads configuration rather than behaviour.
 */
const options = buildAuthOptions(
  {
    NODE_ENV: "test",
    APP_URL: "https://brf.example",
    BETTER_AUTH_SECRET: "0123456789abcdef0123456789abcdef",
  } as Env,
  {} as PrismaService,
  {
    accountState: () =>
      Promise.resolve({ exists: false, hasSecondFactor: false }),
    send: () => Promise.resolve(),
    sendSecondFactorNotice: () => Promise.resolve(),
  },
  {
    declared: true,
    path: "/api/plugin/mcp-connector/mcp",
    url: "https://brf.example/api/plugin/mcp-connector/mcp",
  },
);

/**
 * The magic-link policy, tested on its own.
 *
 * Every branch has to end in the same visible outcome, because the endpoint
 * that reaches this is public and serves an instance holding a statutory
 * register: any difference a caller can observe enumerates accounts.
 */

interface Recorded {
  delivery: MagicLinkDelivery;
  sent: string[];
  notices: string[];
}

function recording(state: AccountState): Recorded {
  const sent: string[] = [];
  const notices: string[] = [];

  return {
    sent,
    notices,
    delivery: {
      accountState: () => Promise.resolve(state),
      send: ({ email }) => {
        sent.push(email);
        return Promise.resolve();
      },
      sendSecondFactorNotice: ({ email }) => {
        notices.push(email);
        return Promise.resolve();
      },
    },
  };
}

const request = {
  email: "resident@exempel.se",
  url: "https://brf.example/api/auth/magic-link/verify?token=t",
  expiresAt: new Date("2026-08-27T12:15:00Z"),
};

describe("deliverMagicLink", () => {
  it("sends the link to an account without a second factor", async () => {
    const { delivery, sent, notices } = recording({
      exists: true,
      hasSecondFactor: false,
    });

    await deliverMagicLink(delivery, request);

    expect(sent).toEqual([request.email]);
    expect(notices).toEqual([]);
  });

  it("mails an explanation instead of a link when TOTP is enrolled", async () => {
    const { delivery, sent, notices } = recording({
      exists: true,
      hasSecondFactor: true,
    });

    await deliverMagicLink(delivery, request);

    // A magic link mints a session directly, so issuing one to a TOTP account
    // would walk around the second factor with mailbox access alone.
    expect(sent).toEqual([]);
    expect(notices).toEqual([request.email]);
  });

  it("sends nothing at all to an address with no account", async () => {
    const { delivery, sent, notices } = recording({
      exists: false,
      hasSecondFactor: false,
    });

    await deliverMagicLink(delivery, request);

    // Better Auth calls this before it checks whether the user exists, so
    // without the guard anyone could make the instance mail a sign-in link to
    // an address of their choosing.
    expect(sent).toEqual([]);
    expect(notices).toEqual([]);
  });

  it("resolves for every account state, so the caller cannot tell them apart", async () => {
    const states: AccountState[] = [
      { exists: true, hasSecondFactor: false },
      { exists: true, hasSecondFactor: true },
      { exists: false, hasSecondFactor: false },
    ];

    for (const state of states) {
      await expect(
        deliverMagicLink(recording(state).delivery, request),
      ).resolves.toBeUndefined();
    }
  });
});

/**
 * The rate-limit configuration, read off the options object.
 *
 * Better Auth's own rules are what defend the credential paths, and they are
 * tighter than the default this file sets: three attempts per ten seconds on
 * /sign-in, /sign-up, /change-password and /change-email, three per ten on
 * /two-factor/*, five per minute on the magic link's two paths. A custom rule
 * replaces whichever of those it matches, which makes customRules the one place
 * from which a brute-force defence could be widened without anybody meaning to.
 * These assertions are that nothing in it reaches such a path - the behaviour
 * either side of the session read's budget is in auth.int-spec.ts, over HTTP,
 * because it is the limiter's counting that decides it and not this object.
 */
describe("the auth rate-limit configuration", () => {
  it("carries a rule for the session read and for nothing else", () => {
    expect(Object.keys(options.rateLimit.customRules)).toEqual([
      SESSION_READ_PATH,
    ]);
    // A pattern is matched with a wildcard and a bare path by equality, so a
    // rule that is spelled out cannot spread to a neighbouring path however the
    // endpoints are later named.
    expect(SESSION_READ_PATH).not.toContain("*");
  });

  it("gives the session read a wider budget over a shorter window", () => {
    const rule = options.rateLimit.customRules[SESSION_READ_PATH];

    // Wider, because the caller is the interface rather than somebody trying
    // credentials; shorter, because the count only clears after a window in
    // which the address asked nothing, so a long window is a budget an
    // interface in continuous use never gets back.
    expect(rule.max).toBeGreaterThan(RATE_LIMIT_MAX);
    expect(rule.window).toBeLessThan(options.rateLimit.window);
    expect(rule).toEqual({
      max: SESSION_READ_MAX,
      window: SESSION_READ_WINDOW_SECONDS,
    });
  });
});

/**
 * The tables the sign-in library reaches for, against the ones the schema
 * declares.
 *
 * The adapter resolves a model by name - it reaches the delegate as
 * `db[model]` - so the model names in schema.prisma are not a naming choice
 * but part of the contract with the library. A rename that reads as tidying
 * produces no type error at the call site and no failure until a member tries
 * to connect an app, where it surfaces as the table not existing.
 *
 * Both halves are needed and they fail for opposite reasons. The runtime
 * assertion catches the library adding or renaming a table, by comparing
 * against what the plugins themselves declare. The type assertion catches us
 * renaming a model, because the union below then stops being assignable to the
 * client's own keys.
 */
describe("the tables the sign-in plugins need", () => {
  type RequiredDelegate =
    | "jwks"
    | "oauthAccessToken"
    | "oauthClient"
    | "oauthClientAssertion"
    | "oauthClientResource"
    | "oauthConsent"
    | "oauthRefreshToken"
    | "oauthResource"
    | "passkey"
    | "twoFactor"
    | "user";

  // Every table any configured plugin declares, not only the OAuth ones: the
  // second factor and passkeys declare their own, and the account model is
  // extended with the field that links an account to a person.
  const REQUIRED: readonly RequiredDelegate[] = [
    "jwks",
    "oauthAccessToken",
    "oauthClient",
    "oauthClientAssertion",
    "oauthClientResource",
    "oauthConsent",
    "oauthRefreshToken",
    "oauthResource",
    "passkey",
    "twoFactor",
    "user",
  ];

  it("declares exactly the delegates the schema provides", () => {
    const declared = options.plugins
      .flatMap((plugin) =>
        "schema" in plugin ? Object.keys(plugin.schema ?? {}) : [],
      )
      .toSorted();

    expect(declared).toEqual([...REQUIRED]);
  });

  it("resolves every one of them on the generated client", () => {
    // A type-level assertion: this line stops compiling if a model in
    // schema.prisma is renamed away from the name the adapter looks up.
    type Missing = Exclude<RequiredDelegate, keyof PrismaClient>;
    const missing: Missing[] = [];

    expect(missing).toEqual([]);
  });
});

/**
 * The sign-in options a connected app is issued a token under.
 *
 * Read off the plugin object rather than restated, so that these are
 * assertions about what the library was actually configured with.
 */
describe("the OAuth provider configuration", () => {
  const provider = options.plugins.find(
    (plugin) => plugin.id === "oauth-provider",
  );

  it("is registered", () => {
    // Registered under "oauth-provider" rather than under "mcp": the plugin
    // spreads the provider's own definition and overrides one hook, so there
    // is no second provider plugin to register beside it.
    expect(provider).toBeDefined();
  });

  it("binds every token to the resolved protected resource, and to nothing else", () => {
    // One entry, so no second audience was configured beside it.
    expect(provider?.options.resources).toHaveLength(1);
    expect(provider?.options.resources?.[0]).toMatchObject({
      identifier: "https://brf.example/api/plugin/mcp-connector/mcp",
    });
  });

  it("bounds what a token for that resource may carry", () => {
    const declared = provider?.options.resources?.[0];

    // Declared at the resource, underneath the client and the person, so a
    // client registered with a wider list still cannot obtain one here.
    // Without this the row is written with no restriction at all.
    expect(declared).toMatchObject({
      allowedScopes: ["mcp:read", "mcp:write"],
    });
    // offline_access governs whether a refresh token is issued; it is not
    // something this resource is reached with.
    expect(
      (declared as { allowedScopes?: string[] }).allowedScopes,
    ).not.toContain("offline_access");
  });

  it("issues opaque tokens", () => {
    // The whole reason a disconnect takes effect on the next call rather than
    // when the token would have expired: there are no claims to trust, so
    // every call resolves the row.
    expect(provider?.options.disableJwtPlugin).toBe(true);
    expect(provider?.options.storeClientSecret).toBe("encrypted");
  });

  it("hashes a token with our own digest", () => {
    // Pinned rather than left to the default, so an upstream change cannot
    // silently stop every live token resolving. The alternative the option
    // also accepts is the string "hashed", which is the default this replaces.
    const stored = provider?.options.storeTokens;

    expect(typeof stored).toBe("object");
    if (typeof stored !== "object") return;
    expect(stored.hash("openbrf", "access_token")).toBe(
      hashOpaqueToken("openbrf"),
    );
  });

  it("lets no client register itself on its own terms", () => {
    expect(provider?.options.allowDynamicClientRegistration).toBe(false);
    expect(provider?.options.allowUnauthenticatedClientRegistration).toBe(
      false,
    );
  });

  it("advertises no scope that would yield the person's identity", () => {
    const advertised = provider?.options.advertisedMetadata?.scopes_supported;

    // openid, profile and email are absent on purpose: with them the document
    // becomes the OpenID variant, an id token is issued and the client
    // receives the person's name and address.
    expect(advertised).toEqual(["mcp:read", "mcp:write"]);
    for (const scope of ["openid", "profile", "email"]) {
      expect(provider?.options.scopes).not.toContain(scope);
    }
  });

  it("keeps offline_access grantable but unadvertised", () => {
    // A refresh token is what keeps a fifteen-minute access token usable, so
    // it must be grantable; it is not something a client chooses to ask for.
    expect(provider?.options.scopes).toContain("offline_access");
    expect(
      provider?.options.advertisedMetadata?.scopes_supported,
    ).not.toContain("offline_access");
  });

  it("drops the rules for the endpoints that take no unauthenticated traffic", () => {
    // Six by default; introspect, register and userinfo are switched off, and
    // switching one off removes its rule rather than widening it.
    expect(provider?.rateLimit).toHaveLength(3);
  });
});

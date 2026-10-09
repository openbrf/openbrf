import { validateCimdMetadata } from "@better-auth/cimd";
import { isAcceptableRedirectUri } from "@openbrf/shared";
import type { BetterAuthOptions } from "better-auth";
import { describe, expect, it } from "vitest";

import type { Env } from "../config/env";
import type { PrismaClient } from "../generated/prisma/client";
import type { PrismaService } from "../database/prisma.service";
import {
  type AccountState,
  buildAuthOptions,
  CALLER_SETTABLE_USER_FIELDS,
  CIMD_METADATA_RULES,
  CLIENT_MANAGEMENT_PATHS,
  deliverMagicLink,
  type MagicLinkDelivery,
  RATE_LIMIT_MAX,
  SESSION_READ_MAX,
  SESSION_READ_PATH,
  SESSION_READ_WINDOW_SECONDS,
  USER_UPDATE_PATH,
} from "./auth-options";
import { hashOpaqueToken } from "./opaque-token";

/** The one account the stub below says may manage OAuth clients. */
const MANAGING_ACCOUNT = "account-that-may-manage";

/**
 * One options object, built the way the application builds it, for every
 * assertion below that reads configuration rather than behaviour.
 */
const options = buildAuthOptions(
  {
    NODE_ENV: "test",
    APP_URL: "https://brf.example",
    BETTER_AUTH_SECRET: "0123456789abcdef0123456789abcdef",
    TRUSTED_PROXIES: ["172.16.0.0/12"],
  } as Env,
  {} as PrismaService,
  {
    accountState: () =>
      Promise.resolve({ exists: false, hasSecondFactor: false }),
    send: () => Promise.resolve(),
    sendSecondFactorNotice: () => Promise.resolve(),
    background: () => undefined,
  },
  {
    declared: true,
    path: "/api/plugin/mcp-connector/mcp",
    url: "https://brf.example/api/plugin/mcp-connector/mcp",
  },
  {
    mayManageClients: (userId) => Promise.resolve(userId === MANAGING_ACCOUNT),
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
      background: (task) => void task(),
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
    /*
     * A type-level assertion: this stops compiling if a model in
     * schema.prisma is renamed away from the name the adapter looks up.
     *
     * A conditional type rather than `const missing: Missing[] = []`. An empty
     * array literal is assignable to every array type, a non-empty `Missing[]`
     * included, so that form compiles and passes whatever the exclusion leaves
     * behind - it reads as the assertion it is not. The tuple wrappers keep
     * `never` from distributing, so this asks whether `Missing` is empty
     * rather than asking nothing at all.
     */
    type Missing = Exclude<RequiredDelegate, keyof PrismaClient>;
    const noneMissing: [Missing] extends [never] ? true : false = true;

    expect(noneMissing).toBe(true);
  });
});

/**
 * What a caller may write to its own user row through Better Auth.
 *
 * Better Auth takes a field from a request body unless the field says
 * `input: false`, and its own default is to take it. Every field this
 * application or a plugin adds to the user is therefore checked here, so a new
 * one has to be declared caller-settable on purpose rather than by omission.
 */
describe("the user fields a caller may set", () => {
  const additional: Record<string, { input?: boolean }> =
    options.user.additionalFields;

  const fromPlugins = options.plugins.flatMap((plugin) => {
    const schema = "schema" in plugin ? plugin.schema : undefined;
    const user = (
      schema as
        { user?: { fields?: Record<string, { input?: boolean }> } } | undefined
    )?.user;
    return Object.entries(user?.fields ?? {}).map(
      ([name, field]) => [`${plugin.id}.${name}`, field] as const,
    );
  });

  it("takes none of this application's user fields from a request", () => {
    expect(Object.keys(additional)).not.toHaveLength(0);
    for (const [name, field] of Object.entries(additional)) {
      if (CALLER_SETTABLE_USER_FIELDS.includes(name)) continue;
      expect({ name, input: field.input }).toEqual({ name, input: false });
    }
  });

  it("takes none of the plugins' user fields from a request", () => {
    expect(fromPlugins).not.toHaveLength(0);
    for (const [label, field] of fromPlugins) {
      if (CALLER_SETTABLE_USER_FIELDS.includes(label)) continue;
      expect({ label, input: field.input }).toEqual({ label, input: false });
    }
  });

  it("closes Better Auth's own user-update endpoint", () => {
    expect(options.disabledPaths).toContain(USER_UPDATE_PATH);
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

/**
 * Who may register and manage an OAuth client.
 *
 * An administrator, through `POST /api/oauth-clients`, and nobody else. The
 * provider's own client endpoints ask for a session and no more, so on their
 * own terms any account could register a client under any name and host, send
 * its codes anywhere, and rewrite it later. Two things close that, and they are
 * asserted separately because they close different doors: the paths answer 404
 * over HTTP, and the hook refuses a call through `auth.api` that the paths do
 * not see.
 */
describe("who may manage an OAuth client", () => {
  const provider = options.plugins.find(
    (plugin) => plugin.id === "oauth-provider",
  );

  const privileges = provider?.options.clientPrivileges;
  type Check = Parameters<NonNullable<typeof privileges>>[0];

  const ACTIONS: readonly Check["action"][] = [
    "create",
    "read",
    "update",
    "delete",
    "list",
    "rotate",
    "configure-client-credentials-scopes",
  ];

  /** What the hook answers for one action, asked as one account or none. */
  function answer(action: Check["action"], userId: string | undefined) {
    return privileges?.({
      headers: new Headers(),
      action,
      user:
        userId === undefined ? undefined : ({ id: userId } as Check["user"]),
    });
  }

  it("closes every client endpoint a request can reach, except the public read", () => {
    /*
     * Read off the provider rather than restated, so a library upgrade that
     * adds a client endpoint, or renames one of these, fails here instead of
     * leaving the new path open. SERVER_ONLY endpoints are not reachable over
     * HTTP at all.
     */
    const reachable = Object.values(provider?.endpoints ?? {})
      .filter(
        (endpoint) =>
          (endpoint.options.metadata as { SERVER_ONLY?: boolean } | undefined)
            ?.SERVER_ONLY !== true,
      )
      .map((endpoint) => endpoint.path)
      .filter((path) => path.includes("client"));

    // The consent screen reads a client's name and host from the first; the
    // second returns the same public fields before sign-in.
    const stillOpen = [
      "/oauth2/public-client",
      "/oauth2/public-client-prelogin",
    ];

    expect(
      reachable.filter((path) => !stillOpen.includes(path)).toSorted(),
    ).toEqual([...CLIENT_MANAGEMENT_PATHS].toSorted());
    expect(options.disabledPaths).toEqual([
      ...CLIENT_MANAGEMENT_PATHS,
      USER_UPDATE_PATH,
    ]);
    for (const path of stillOpen) {
      expect(options.disabledPaths).not.toContain(path);
    }
  });

  it("lets an account that may manage the association do every client action", async () => {
    for (const action of ACTIONS) {
      expect(await answer(action, MANAGING_ACCOUNT)).toBe(true);
    }
  });

  it("refuses every client action to any other account", async () => {
    for (const action of ACTIONS) {
      expect(await answer(action, "a-resident-account")).toBe(false);
    }
  });

  it("refuses a call that carries no account", async () => {
    for (const action of ACTIONS) {
      expect(await answer(action, undefined)).toBe(false);
    }
  });

  it("issues no token to a client acting as itself", () => {
    // Every token here acts for a person who consented to it. Without the list
    // the provider also offers client_credentials, a token with nobody behind
    // it.
    expect(provider?.options.grantTypes).toEqual([
      "authorization_code",
      "refresh_token",
    ]);
  });
});

describe("a client that identifies itself by its metadata document", () => {
  const CLIENT_ID = "https://apps.exempel.se/brf-klient.json";

  /** The library's own check of a document, with the rules configured here. */
  function takes(redirectUri: string): boolean {
    return validateCimdMetadata(
      CLIENT_ID,
      {
        client_id: CLIENT_ID,
        client_name: "Klient",
        redirect_uris: [redirectUri],
      },
      CIMD_METADATA_RULES,
    ).valid;
  }

  it.each([
    "https://apps.exempel.se/cb",
    "http://127.0.0.1:8123/cb",
    "http://localhost:8123/cb",
    "se.exempel.app:/callback",
  ])("may send the code to %s", (uri) => {
    expect(takes(uri)).toBe(true);
    // And the consent screen goes on to it, by the rule it shares with
    // registration.
    expect(isAcceptableRedirectUri(uri)).toBe(true);
  });

  it.each([
    // On another origin than the one the consent screen names it by.
    "https://other.exempel.se/cb",
    "https://apps.exempel.se.evil.example/cb",
    "http://apps.exempel.se/cb",
    "http://other.exempel.se/cb",
  ])("may not send the code to %s", (uri) => {
    expect(takes(uri)).toBe(false);
  });
});

describe("the sign-in routes' own origin check", () => {
  it("is left on, for every route under /api/auth", () => {
    /*
     * The authorization guard leaves /api/auth to the library, whose router
     * checks every request but a read on every path: one carrying the cookie
     * has to name a trusted origin in Origin or Referer, and is refused when
     * it names none. Off only under NODE_ENV=test or when one of these is set,
     * so neither may be.
     */
    const configured: BetterAuthOptions = options;
    expect(configured.advanced?.disableOriginCheck).toBeUndefined();
    expect(configured.advanced?.disableCSRFCheck).toBeUndefined();
    expect(configured.trustedOrigins).toBeUndefined();
  });
});

describe("the client address the sign-in limiter counts", () => {
  it("is the one address in the header, which the bridge has already resolved", () => {
    // fastify-bridge.ts replaces the header with the address clientAddressOf
    // resolves past the named proxies. A proxy list here as well would make
    // the library skip that address whenever it is a proxy's own.
    expect(options.advanced.ipAddress).toEqual({
      ipAddressHeaders: ["x-forwarded-for"],
    });
  });
});

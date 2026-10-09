import {
  createRootRoute,
  createRoute,
  createRouter,
  defaultParseSearch,
  defaultStringifySearch,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it } from "vitest";

import {
  APP_BASE_PATH,
  authorizationRequestIn,
  consentHref,
  signInHref,
  stringifyKeeping,
  stringifySearch,
  validateAuthorizationSearch,
} from "./authorization-request";

/**
 * Getting a signed authorization request across the sign-in screen intact.
 *
 * The request is not in a cookie. It is in the query string, it is signed over
 * its own parameters, and the signature is checked against the parameters as
 * they arrive - so anything that reorders, re-encodes or collapses one of them
 * turns a member's consent into a refusal nobody can explain. These are the
 * two ways that happens and the reason each one is avoided.
 */

/**
 * One as the provider composes it.
 *
 * `ba_param` names every parameter the signature covers, and so appears once
 * per name. `scope` carries a space and colons, which are encoded. `exp` and
 * `ba_iat` are bare numbers.
 */
const REQUEST =
  "?response_type=code&client_id=https%3A%2F%2Fapp.example%2Fmetadata.json" +
  "&redirect_uri=https%3A%2F%2Fapp.example%2Fcallback&scope=mcp%3Aread+mcp%3Awrite" +
  "&state=n0nce&code_challenge=ZHVtbXktY2hhbGxlbmdl&code_challenge_method=S256" +
  "&resource=https%3A%2F%2Fbrf.example%2Fapi%2Fplugin%2Fmcp-connector%2Fmcp" +
  "&prompt=consent&exp=1789000000&ba_iat=1788999700" +
  "&ba_param=ba_iat&ba_param=client_id&ba_param=code_challenge" +
  "&ba_param=code_challenge_method&ba_param=exp&ba_param=prompt" +
  "&ba_param=redirect_uri&ba_param=resource&ba_param=response_type" +
  "&ba_param=scope&ba_param=state&sig=c2lnbmF0dXJl";

describe("recognising an authorization request", () => {
  it("hands back the search string exactly as it was given", () => {
    expect(authorizationRequestIn(REQUEST)).toBe(REQUEST);
  });

  it("is not one without a client", () => {
    expect(authorizationRequestIn("?sig=c2lnbmF0dXJl")).toBeNull();
  });

  it("is not one without a signature", () => {
    expect(authorizationRequestIn("?client_id=app")).toBeNull();
  });

  it("is not one when a deep link was what brought the visitor here", () => {
    expect(authorizationRequestIn("?returnTo=%2Fdocuments")).toBeNull();
    expect(authorizationRequestIn("")).toBeNull();
  });
});

describe("the address of the consent screen", () => {
  it("carries the request unchanged, under the application's own path", () => {
    expect(consentHref(REQUEST)).toBe(
      `${APP_BASE_PATH}/oauth/consent${REQUEST}`,
    );
  });

  it("keeps every occurrence of the repeated parameter", () => {
    const carried = new URLSearchParams(
      consentHref(REQUEST).slice(consentHref(REQUEST).indexOf("?")),
    );
    expect(carried.getAll("ba_param")).toEqual(
      new URLSearchParams(REQUEST).getAll("ba_param"),
    );
  });

  it("writes the delimiter when the caller passes a bare query", () => {
    expect(consentHref("client_id=app&sig=s")).toBe(
      `${APP_BASE_PATH}/oauth/consent?client_id=app&sig=s`,
    );
  });
});

describe("the way back to sign in with the request still in hand", () => {
  it("carries it unchanged, so the round trip does not spend the signature", () => {
    expect(signInHref(REQUEST)).toBe(`${APP_BASE_PATH}/sign-in${REQUEST}`);
  });
});

describe("what the router would do to the request if it built the address", () => {
  /*
   * The reason the hop is a document navigation onto a string this module
   * composes, rather than anything `navigate({ to })` or `useLocation` hands
   * back. The router parses a search string into an object and serialises it
   * back for every location it builds, and that round trip keeps one value per
   * name. If this ever stops being true the indirection can go - and this test
   * is what would say so.
   */
  it("collapses the repeated parameter into a single value", () => {
    const roundTripped = defaultStringifySearch(defaultParseSearch(REQUEST));
    const parameters = new URLSearchParams(roundTripped);

    expect(parameters.getAll("ba_param")).toHaveLength(1);
    expect(
      new URLSearchParams(REQUEST).getAll("ba_param").length,
    ).toBeGreaterThan(1);
  });

  it("leaves the request the consent screen posts untouched by comparison", () => {
    // Same input, the two routes side by side: one arrives as it was written.
    expect(authorizationRequestIn(REQUEST)).toBe(REQUEST);
    expect(defaultStringifySearch(defaultParseSearch(REQUEST))).not.toBe(
      REQUEST,
    );
  });
});

describe("what the sign-in and consent routes declare", () => {
  it("keeps every parameter of the request, the repeated one included", () => {
    const declared = validateAuthorizationSearch(defaultParseSearch(REQUEST));

    expect(declared.response_type).toBe("code");
    expect(declared.client_id).toBe("https://app.example/metadata.json");
    expect(declared.redirect_uri).toBe("https://app.example/callback");
    expect(declared.scope).toBe("mcp:read mcp:write");
    expect(declared.state).toBe("n0nce");
    expect(declared.code_challenge).toBe("ZHVtbXktY2hhbGxlbmdl");
    expect(declared.code_challenge_method).toBe("S256");
    expect(declared.resource).toBe(
      "https://brf.example/api/plugin/mcp-connector/mcp",
    );
    expect(declared.prompt).toBe("consent");
    expect(declared.exp).toBe(1789000000);
    expect(declared.ba_iat).toBe(1788999700);
    expect(declared.sig).toBe("c2lnbmF0dXJl");
    expect(declared.ba_param).toEqual(
      new URLSearchParams(REQUEST).getAll("ba_param"),
    );
  });

  it("declares a parameter the route does not know as nothing at all", () => {
    const declared = validateAuthorizationSearch({ somethingElse: "kept out" });

    expect("somethingElse" in declared).toBe(false);
  });

  it("keeps a path this application can go back to", () => {
    expect(
      validateAuthorizationSearch({ returnTo: "/documents?shelf=styrelsen" })
        .returnTo,
    ).toBe("/documents?shelf=styrelsen");
  });

  it("drops a returnTo that leaves the origin, so it never reaches the URL", () => {
    for (const value of ["//evil.example", "https://evil.example", "/\\evil"]) {
      expect(validateAuthorizationSearch({ returnTo: value }).returnTo).toBe(
        undefined,
      );
    }
  });
});

describe("how the router writes a search string", () => {
  it("keeps the address bar's spelling of a query it means the same by", () => {
    expect(stringifyKeeping(REQUEST, defaultParseSearch(REQUEST))).toBe(
      REQUEST,
    );
  });

  it("ignores a parameter a route declared and the query does not carry", () => {
    // The shape the sign-in and consent routes hand back: every declared
    // name, the missing ones undefined.
    const declared = {
      ...defaultParseSearch(REQUEST),
      ...validateAuthorizationSearch(defaultParseSearch(REQUEST)),
    };

    expect(stringifyKeeping(REQUEST, declared)).toBe(REQUEST);
  });

  it("writes its own spelling of a search that means something else", () => {
    const asked = { returnTo: "/documents" };

    expect(stringifyKeeping(REQUEST, asked)).toBe(
      defaultStringifySearch(asked),
    );
    expect(stringifyKeeping("", asked)).toBe(defaultStringifySearch(asked));
    expect(stringifyKeeping(REQUEST, {})).toBe("");
  });

  it("writes its own spelling once a value in the query has changed", () => {
    const altered = { ...defaultParseSearch(REQUEST), state: "someone-else" };

    expect(stringifyKeeping(REQUEST, altered)).toBe(
      defaultStringifySearch(altered),
    );
  });
});

describe("the address bar on a screen carrying a request, once the router has mounted", () => {
  afterEach(() => {
    cleanup();
    window.history.replaceState(null, "", "/");
  });

  const CONSENT = `${APP_BASE_PATH}/oauth/consent`;

  /** A document loaded at the consent screen, with a router mounted on it. */
  async function mountAt(
    options: { stringifySearch?: typeof stringifySearch } = {},
  ): Promise<void> {
    const rootRoute = createRootRoute();
    const consentRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: "/oauth/consent",
      validateSearch: validateAuthorizationSearch,
      component: () => createElement("p", null, "consent"),
    });
    const router = createRouter({
      routeTree: rootRoute.addChildren([consentRoute]),
      basepath: APP_BASE_PATH,
      ...options,
    });
    const view = render(createElement(RouterProvider, { router }));
    await view.findByText("consent");
    await router.load();
  }

  /*
   * The seam itself, with the router this application uses and without the
   * one thing this module gives it. Mounting it on a page carrying a signed
   * request rewrites the address bar into its own spelling, and a reload of
   * that page loads the spelling the signature does not cover. If this ever
   * stops being true `stringifySearch` can go - and this test is what would
   * say so.
   */
  it("is re-spelled by the router left to its defaults", async () => {
    window.history.replaceState(null, "", `${CONSENT}${REQUEST}`);

    await mountAt();

    await waitFor(() => {
      expect(window.location.search).not.toBe(REQUEST);
    });
    expect(
      new URLSearchParams(window.location.search).getAll("ba_param"),
    ).toHaveLength(1);
  });

  it("stays the request as it was written, across a reload as well", async () => {
    window.history.replaceState(null, "", `${CONSENT}${REQUEST}`);

    await mountAt({ stringifySearch });
    expect(window.location.search).toBe(REQUEST);

    // A reload is a new document at the same address, and a new router.
    cleanup();
    await mountAt({ stringifySearch });
    expect(window.location.pathname).toBe(CONSENT);
    expect(window.location.search).toBe(REQUEST);
    expect(authorizationRequestIn(window.location.search)).toBe(REQUEST);
  });
});

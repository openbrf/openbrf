import type { FastifyRequest } from "fastify";
import { describe, expect, it } from "vite-plus/test";

import { REPORTER_LINK_TOKEN_PATTERN } from "../issues/issue-reporter-link-token";
import {
  isReporterLinkPath,
  isReporterLinkRequest,
} from "./site-issue-link-headers";

/**
 * Which requests carry the reporter's link headers (ADR 0055): decided by the
 * decoded path where it is a token's address, else by the route the router
 * matched, else by the decoded path. Each branch is pinned here, with the
 * router's matched route stood in for by `routeOptions.url`.
 */

const TOKEN = `obrf_rl_${"A".repeat(43)}`;
const TOKEN_ROUTE = `/arende/:token(^${REPORTER_LINK_TOKEN_PATTERN}$)`;

function request(url: string, matched?: string): FastifyRequest {
  return {
    url,
    routeOptions: matched === undefined ? undefined : { url: matched },
  } as unknown as FastifyRequest;
}

describe("isReporterLinkRequest", () => {
  const cases: {
    name: string;
    url: string;
    matched: string | undefined;
    expected: boolean;
  }[] = [
    // No route matched: the router's own 404. The decoded path decides.
    {
      name: "no route, a path on the link",
      url: "/arende/anything",
      matched: undefined,
      expected: true,
    },
    {
      name: "no route, the link's own path",
      url: "/arende",
      matched: undefined,
      expected: true,
    },
    {
      name: "no route, an escaped letter in the link's path",
      url: "/%61rende/anything",
      matched: undefined,
      expected: true,
    },
    {
      name: "no route, a path elsewhere",
      url: "/om-oss",
      matched: undefined,
      expected: false,
    },
    {
      name: "no route, a path that only starts with the link's name",
      url: "/arendehantering",
      matched: undefined,
      expected: false,
    },
    // A wildcard route is not a decision about the link: the decoded path is.
    {
      name: "a * route, a path on the link",
      url: "/arende/anything",
      matched: "*",
      expected: true,
    },
    {
      name: "a * route, a path elsewhere",
      url: "/om-oss",
      matched: "*",
      expected: false,
    },
    {
      name: "a /* route, a path on the link",
      url: "/arende/anything",
      matched: "/*",
      expected: true,
    },
    {
      name: "a /* route, a path elsewhere",
      url: "/om-oss",
      matched: "/*",
      expected: false,
    },
    // The website's own routes: the matched route decides.
    {
      name: "the website's /:slug route, a page",
      url: "/om-oss",
      matched: "/:slug",
      expected: false,
    },
    {
      name: "the website's /:slug route, the page that kept the slug arende",
      url: "/arende",
      matched: "/:slug",
      expected: false,
    },
    {
      name: "the website's form route below a kept slug",
      url: "/arende/kontakt",
      matched: "/:slug/kontakt",
      expected: false,
    },
    // An escaped slash is one segment to the router, so /:slug matches it.
    {
      name: "the website's /:slug route, an escaped slash before a token",
      url: `/arende%2F${TOKEN}`,
      matched: "/:slug",
      expected: true,
    },
    {
      name: "the website's /:slug route, an escaped slash and an escaped letter before a token",
      url: `/%61rende%2f${TOKEN}`,
      matched: "/:slug",
      expected: true,
    },
    {
      name: "the website's /:slug route, an escaped slash before a kept slug's form",
      url: "/arende%2Fkontakt",
      matched: "/:slug",
      expected: false,
    },
    {
      name: "the website's /:slug route, an escaped slash before a token with more after it",
      url: `/arende%2F${TOKEN}%2Fkontakt`,
      matched: "/:slug",
      expected: false,
    },
    {
      name: "the website's /:slug route, a token outside /arende",
      url: `/annat%2F${TOKEN}`,
      matched: "/:slug",
      expected: false,
    },
    // The link's own routes.
    {
      name: "the token's route",
      url: `/arende/${TOKEN}`,
      matched: TOKEN_ROUTE,
      expected: true,
    },
    {
      name: "the token's route, spelled with an escaped letter",
      url: `/%61rende/${TOKEN}`,
      matched: TOKEN_ROUTE,
      expected: true,
    },
    {
      name: "the segment route a value that is not a token reaches",
      url: "/arende/not-a-token",
      matched: "/arende/:segment",
      expected: true,
    },
    {
      name: "the link's routes read with a query string",
      url: `/arende/${TOKEN}?notice=sent`,
      matched: TOKEN_ROUTE,
      expected: true,
    },
  ];

  it.each(cases)("$name", ({ url, matched, expected }) => {
    expect(isReporterLinkRequest(request(url, matched))).toBe(expected);
  });

  it("reads a malformed escape as written, as the router refuses it first", () => {
    expect(isReporterLinkRequest(request("/arende/%E0%A4%A", undefined))).toBe(
      true,
    );
    expect(isReporterLinkRequest(request("/om-oss/%E0%A4%A", undefined))).toBe(
      false,
    );
  });
});

describe("isReporterLinkPath", () => {
  it("is the link's path and what is below it, and nothing that only starts alike", () => {
    expect(isReporterLinkPath("/arende")).toBe(true);
    expect(isReporterLinkPath("/arende/x?y=1")).toBe(true);
    expect(isReporterLinkPath("/arendeX")).toBe(false);
    expect(isReporterLinkPath("/")).toBe(false);
  });
});

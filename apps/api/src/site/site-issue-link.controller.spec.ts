import { RequestMethod } from "@nestjs/common";
import { METHOD_METADATA, PATH_METADATA } from "@nestjs/common/constants";
import { describe, expect, it } from "vite-plus/test";

import { IS_PUBLIC_ROUTE } from "../authorization/public.decorator";
import { PUBLIC_RATE_LIMIT } from "../http/public-rate-limit.decorator";
import { REPORTER_LINK_TOKEN_PATTERN } from "../issues/issue-reporter-link-token";
import {
  LINK_READS_PER_MINUTE,
  LINK_WRITES_PER_MINUTE,
  SiteIssueLinkController,
} from "./site-issue-link.controller";

/**
 * D1 of the link's threat review: every route of the reporter's link carries a
 * per-address budget, the GET included (ADR 0055). Read from the route
 * metadata, so a route added later without one fails here.
 */

function routes(): { name: string; method: RequestMethod }[] {
  const prototype = SiteIssueLinkController.prototype as unknown as Record<
    string,
    unknown
  >;
  return Object.getOwnPropertyNames(prototype)
    .filter((name) => name !== "constructor")
    .map((name) => ({ name, handler: prototype[name] }))
    .filter(
      ({ handler }) =>
        typeof handler === "function" &&
        Reflect.getMetadata(PATH_METADATA, handler) !== undefined,
    )
    .map(({ name, handler }) => ({
      name,
      method: Reflect.getMetadata(
        METHOD_METADATA,
        handler as object,
      ) as RequestMethod,
    }));
}

describe("the reporter's link controller", () => {
  it("has the page's GET and POST, the GET of a malformed token, and nothing else", () => {
    expect(
      routes()
        .map((route) => route.method)
        .sort((a, b) => a - b),
    ).toEqual(
      [RequestMethod.GET, RequestMethod.GET, RequestMethod.POST].sort(
        (a, b) => a - b,
      ),
    );
  });

  it("matches the page's routes on the token's form alone", () => {
    const prototype = SiteIssueLinkController.prototype as unknown as Record<
      string,
      object
    >;
    for (const name of ["page", "message"]) {
      const path = Reflect.getMetadata(
        PATH_METADATA,
        prototype[name] ?? {},
      ) as string;
      expect(path).toBe(`:token(^${REPORTER_LINK_TOKEN_PATTERN}$)`);
    }
  });

  it("puts every route behind a per-address budget", () => {
    const prototype = SiteIssueLinkController.prototype as unknown as Record<
      string,
      object
    >;
    const budgets = Object.fromEntries(
      routes().map(({ name }) => [
        name,
        (
          Reflect.getMetadata(PUBLIC_RATE_LIMIT, prototype[name] ?? {}) as
            { perMinute: number } | undefined
        )?.perMinute,
      ]),
    );
    expect(budgets).toEqual({
      page: LINK_READS_PER_MINUTE,
      malformed: LINK_READS_PER_MINUTE,
      message: LINK_WRITES_PER_MINUTE,
    });
  });

  it("answers without a session, which is why the budgets are needed", () => {
    expect(Reflect.getMetadata(IS_PUBLIC_ROUTE, SiteIssueLinkController)).toBe(
      true,
    );
  });
});

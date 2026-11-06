import { RequestMethod } from "@nestjs/common";
import { METHOD_METADATA, PATH_METADATA } from "@nestjs/common/constants";
import { describe, expect, it } from "vite-plus/test";

import { IS_PUBLIC_ROUTE } from "../authorization/public.decorator";
import { PUBLIC_RATE_LIMIT } from "../http/public-rate-limit.decorator";
import { WORK_ORDER_LINK_TOKEN_PATTERN } from "../issues/work-order-link-token";
import {
  SiteWorkOrderLinkController,
  WORK_ORDER_LINK_PHOTO_READS_PER_MINUTE,
  WORK_ORDER_LINK_READS_PER_MINUTE,
  WORK_ORDER_LINK_UPLOADS_PER_MINUTE,
  WORK_ORDER_LINK_WRITES_PER_MINUTE,
} from "./site-work-order-link.controller";

/**
 * D1 of the links' threat review: every route of the contractor's link carries
 * a per-address budget, its GETs included (ADR 0055). Read from the route
 * metadata, so a route added later without one fails here.
 */

const prototype = SiteWorkOrderLinkController.prototype as unknown as Record<
  string,
  object
>;

function routes(): { name: string; method: RequestMethod; path: string }[] {
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
      path: Reflect.getMetadata(PATH_METADATA, handler as object) as string,
    }));
}

describe("the contractor's link controller", () => {
  it("D1: puts every route behind a per-address budget", () => {
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
      page: WORK_ORDER_LINK_READS_PER_MINUTE,
      photosPage: WORK_ORDER_LINK_READS_PER_MINUTE,
      photo: WORK_ORDER_LINK_PHOTO_READS_PER_MINUTE,
      act: WORK_ORDER_LINK_WRITES_PER_MINUTE,
      upload: WORK_ORDER_LINK_UPLOADS_PER_MINUTE,
      malformed: WORK_ORDER_LINK_READS_PER_MINUTE,
      malformedBelow: WORK_ORDER_LINK_READS_PER_MINUTE,
      malformedPost: WORK_ORDER_LINK_WRITES_PER_MINUTE,
      malformedPostBelow: WORK_ORDER_LINK_WRITES_PER_MINUTE,
    });
  });

  it("writes only through a POST on an address shaped like a token", () => {
    const token = `:token(^${WORK_ORDER_LINK_TOKEN_PATTERN}$)`;
    // The two posts to any other address only refuse, as the reads of them do,
    // so the framework's own 404 never tells the two apart.
    const refusals = ["malformedPost", "malformedPostBelow"];
    const posts = routes().filter(
      (route) =>
        route.method === RequestMethod.POST && !refusals.includes(route.name),
    );
    expect(posts.map((route) => route.path).sort()).toEqual(
      [token, `${token}/foto`].sort(),
    );
    expect(
      routes()
        .filter((route) => refusals.includes(route.name))
        .map((route) => route.path)
        .sort(),
    ).toEqual([":segment", ":segment/*"]);
  });

  it("answers without a session, which is why the budgets are needed", () => {
    expect(
      Reflect.getMetadata(IS_PUBLIC_ROUTE, SiteWorkOrderLinkController),
    ).toBe(true);
  });
});

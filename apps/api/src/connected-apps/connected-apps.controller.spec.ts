import "reflect-metadata";

import { describe, expect, it } from "vitest";

import type { Capability } from "../authorization/capabilities";
import { IS_PUBLIC_ROUTE } from "../authorization/public.decorator";
import { REQUIRED_CAPABILITIES } from "../authorization/require-capability.decorator";
import {
  ConnectedAppsAdminController,
  MyConnectedAppsController,
  OAuthConsentController,
} from "./connected-apps.controller";
import { OAuthClientsController } from "./oauth-clients.controller";

/**
 * What each connected-apps route demands, read off the route itself.
 *
 * Asserted here because an HTTP test cannot separate these. Every role holding
 * `dataProtection:manage` also holds `association:read`, so a request test
 * shows only that a resident is refused - and would keep passing if cutting
 * somebody else's connection were quietly widened to the capability for merely
 * seeing that it exists.
 *
 * Two rules are being held apart, and the reason is that they are different
 * questions rather than two sizes of the same one:
 *
 *   A member manages their own connections with no capability at all. Granting
 *   an app access to your own data and then needing the board to take it back
 *   is not a coherent arrangement.
 *
 *   Seeing every connection on the instance is part of knowing what leaves the
 *   association. Cutting one on somebody else's behalf is acting on another
 *   person's data, and sits with whoever answers for that.
 */

/** The capabilities declared on one route, class-level ones excluded. */
function requiredOn(
  controller: object,
  method: string,
): Capability[] | undefined {
  const handler = (controller as Record<string, unknown>)[method];
  return Reflect.getMetadata(REQUIRED_CAPABILITIES, handler as object) as
    Capability[] | undefined;
}

/** What the class demands of every route in it. */
function requiredOnClass(target: object): Capability[] | undefined {
  return Reflect.getMetadata(REQUIRED_CAPABILITIES, target) as
    Capability[] | undefined;
}

function isPublicClass(target: object): boolean {
  return Reflect.getMetadata(IS_PUBLIC_ROUTE, target) === true;
}

function isPublicRoute(controller: object, method: string): boolean {
  const handler = (controller as Record<string, unknown>)[method];
  return Reflect.getMetadata(IS_PUBLIC_ROUTE, handler as object) === true;
}

describe("a person's own connected apps", () => {
  const prototype = MyConnectedAppsController.prototype;

  it("needs a session and no capability", () => {
    expect(requiredOnClass(MyConnectedAppsController)).toBeUndefined();
    expect(requiredOn(prototype, "mine")).toBeUndefined();
    expect(requiredOn(prototype, "disconnect")).toBeUndefined();
  });

  it("is not public", () => {
    // No capability is not the same as no session. These routes read and cut
    // one named person's connections, and which person is taken from the
    // session, so an unauthenticated caller has no meaning here at all.
    expect(isPublicClass(MyConnectedAppsController)).toBe(false);
    expect(isPublicRoute(prototype, "mine")).toBe(false);
    expect(isPublicRoute(prototype, "disconnect")).toBe(false);
  });
});

describe("the board's view of every connection", () => {
  const prototype = ConnectedAppsAdminController.prototype;

  it("gates listing on reading the association", () => {
    expect(requiredOn(prototype, "all")).toEqual(["association:read"]);
  });

  it("gates cutting somebody else's connection on answering for their data", () => {
    expect(requiredOn(prototype, "disconnect")).toEqual([
      "dataProtection:manage",
    ]);
  });

  it("does not let reading imply cutting", () => {
    // The two routes sit on the same controller, so a class-level declaration
    // would silently give every reader the power to disconnect.
    expect(requiredOnClass(ConnectedAppsAdminController)).toBeUndefined();
    expect(requiredOn(prototype, "all")).not.toContain("dataProtection:manage");
  });

  it("is not public", () => {
    expect(isPublicClass(ConnectedAppsAdminController)).toBe(false);
  });
});

describe("the consent decision", () => {
  const prototype = OAuthConsentController.prototype;

  it("needs a session and no capability", () => {
    // Whether to let an app act for you is not something the board grants a
    // member permission to decide.
    expect(requiredOnClass(OAuthConsentController)).toBeUndefined();
    expect(requiredOn(prototype, "consent")).toBeUndefined();
  });

  it("is not public", () => {
    // The one assertion on this route that matters most. The person granting
    // is taken from the session, so a public consent route would let anybody
    // grant an app access as somebody else.
    expect(isPublicClass(OAuthConsentController)).toBe(false);
    expect(isPublicRoute(prototype, "consent")).toBe(false);
  });
});

describe("registering a client by hand", () => {
  const prototype = OAuthClientsController.prototype;

  it("gates registration on managing the association", () => {
    expect(requiredOn(prototype, "register")).toEqual(["association:manage"]);
  });

  it("is not public", () => {
    expect(isPublicClass(OAuthClientsController)).toBe(false);
    expect(isPublicRoute(prototype, "register")).toBe(false);
  });
});

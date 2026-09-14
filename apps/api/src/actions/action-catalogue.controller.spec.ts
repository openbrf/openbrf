import { describe, expect, it } from "vitest";

import type { Capability } from "../authorization/capabilities";
import { IS_PUBLIC_ROUTE } from "../authorization/public.decorator";
import { REQUIRED_CAPABILITIES } from "../authorization/require-capability.decorator";
import { ActionCatalogueController } from "./action-catalogue.controller";

/**
 * What the catalogue demands of whoever reads it.
 *
 * Two mistakes are possible here and they fail in opposite directions, which is
 * why both are asserted rather than one. Making it public would publish which
 * plugins a named cooperative runs to anyone who asks - a fact about the
 * association, not about the platform. Gating it on a capability would hide the
 * catalogue from residents, whose own actions are exactly what the AI package
 * will later offer them.
 *
 * A valid session and nothing more is the answer, and under the global guard
 * that state is spelled "declares no capability and is not public" - an absence
 * on both counts, which is precisely the shape a test has to pin, because
 * nothing about the file says it out loud.
 */

function requiredOnClass(target: object): Capability[] | undefined {
  return Reflect.getMetadata(REQUIRED_CAPABILITIES, target) as
    Capability[] | undefined;
}

function requiredOn(
  controller: object,
  method: string,
): Capability[] | undefined {
  const handler = (controller as Record<string, unknown>)[method];
  return Reflect.getMetadata(REQUIRED_CAPABILITIES, handler as object) as
    Capability[] | undefined;
}

/** One route handler, read off the prototype without binding it. */
function handler(controller: object, method: string): object {
  return (controller as Record<string, object>)[method] as object;
}

function isPublic(target: object): boolean | undefined {
  return Reflect.getMetadata(IS_PUBLIC_ROUTE, target) as boolean | undefined;
}

describe("who may read the action catalogue", () => {
  const prototype = ActionCatalogueController.prototype;

  it("demands a session and no capability", () => {
    expect(requiredOnClass(ActionCatalogueController)).toBeUndefined();
    expect(requiredOn(prototype, "list")).toBeUndefined();
    expect(requiredOn(prototype, "byName")).toBeUndefined();
  });

  it("is not public, on the class or on either route", () => {
    // An unauthenticated catalogue would tell the internet which plugins this
    // association has installed.
    expect(isPublic(ActionCatalogueController)).not.toBe(true);
    expect(isPublic(handler(prototype, "list"))).not.toBe(true);
    expect(isPublic(handler(prototype, "byName"))).not.toBe(true);
  });
});

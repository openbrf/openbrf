import { defer, firstValueFrom, isObservable, type Observable, of } from "rxjs";
import { describe, expect, it } from "vite-plus/test";

import {
  markResidentRoute,
  residentRouteHandler,
  residentRouteOf,
  residentRouteScopeOf,
  runOnResidentRoute,
} from "./resident-route-scope";

/**
 * The scope a resident route is served in (ADR 0051), and the handler the
 * seal mounts such a route with.
 *
 * What the wrapper adds is that work starting later from outside the scope,
 * an Observable's subscription, still runs inside it. So each case calls the
 * handler inside the scope and subscribes outside it, as NestJS would if it
 * subscribed from anywhere but the scope's own async context.
 */

const PLUGIN = "parking-share";
const request = {};
const scope = { pluginId: PLUGIN, request, personId: "person-1" };

/** Which plugin's resident route the code that runs now is on, if any. */
function seen(): string | null {
  return residentRouteOf(PLUGIN)?.personId ?? null;
}

describe("the scope of a resident route", () => {
  it("is the plugin's own, and nobody else's", () => {
    runOnResidentRoute(scope, () => {
      expect(residentRouteOf(PLUGIN)).toBe(scope);
      expect(residentRouteOf("another-plugin")).toBeNull();
    });
    expect(residentRouteOf(PLUGIN)).toBeNull();
  });

  it("stays open for work the handler leaves running after it answered", async () => {
    let later: Promise<string | null> = Promise.resolve(null);
    runOnResidentRoute(scope, () => {
      later = new Promise((resolve) => setTimeout(() => resolve(seen()), 5));
    });

    expect(await later).toBe("person-1");
  });

  it("is opened from the guard's mark on the request, and only from it", () => {
    const marked = {};
    markResidentRoute(marked, { pluginId: PLUGIN, personId: "person-1" });

    expect(residentRouteScopeOf(marked)).toEqual({
      pluginId: PLUGIN,
      personId: "person-1",
      request: marked,
    });
    expect(residentRouteScopeOf({})).toBeNull();
  });
});

describe("the handler a resident route is mounted with", () => {
  /** Calls a handler as the router would, inside the route's scope. */
  function served(handler: () => unknown): unknown {
    return runOnResidentRoute(scope, () =>
      residentRouteHandler(PLUGIN, handler).call({}),
    );
  }

  it("subscribes an Observable it returns inside the scope", async () => {
    const result = served(() => defer(() => of(seen())));

    expect(isObservable(result)).toBe(true);
    // Subscribed here, outside the scope.
    expect(await firstValueFrom(result as Observable<unknown>)).toBe(
      "person-1",
    );
  });

  it("subscribes an Observable an async handler resolves to inside the scope", async () => {
    const result = served(async () => defer(() => of(seen())));

    const resolved = await (result as Promise<Observable<unknown>>);
    expect(isObservable(resolved)).toBe(true);
    expect(await firstValueFrom(resolved)).toBe("person-1");
  });

  it("subscribes an Observable a thenable resolves to inside the scope", async () => {
    const thenable = {
      // oxlint-disable-next-line unicorn/no-thenable -- the shape under test
      then(resolve: (value: unknown) => void): void {
        resolve(defer(() => of(seen())));
      },
    };
    const result = served(() => thenable);

    const resolved = await (result as Promise<Observable<unknown>>);
    expect(await firstValueFrom(resolved)).toBe("person-1");
  });

  it("returns any other result as it is", async () => {
    const value = { offers: [] };

    expect(served(() => value)).toBe(value);
    expect(await (served(async () => value) as Promise<unknown>)).toBe(value);
  });

  it("calls the plugin's method on the instance, with the arguments it was given", () => {
    const instance = { label: "Plats 4" };
    const handler = residentRouteHandler(
      PLUGIN,
      function (this: { label: string }, ...args: unknown[]) {
        return [this.label, ...args];
      },
    );

    expect(
      runOnResidentRoute(scope, () => handler.call(instance, "a", 2)),
    ).toEqual(["Plats 4", "a", 2]);
  });

  it("refuses to run the plugin's method outside the scope", () => {
    let ran = false;
    const handler = residentRouteHandler(PLUGIN, () => {
      ran = true;
    });

    expect(() => handler()).toThrow(/outside the scope/);
    expect(() =>
      runOnResidentRoute({ ...scope, pluginId: "another-plugin" }, () =>
        handler(),
      ),
    ).toThrow(/outside the scope/);
    expect(ran).toBe(false);
  });
});

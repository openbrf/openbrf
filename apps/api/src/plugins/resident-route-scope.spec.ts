import { Readable } from "node:stream";

import { StreamableFile } from "@nestjs/common";
import { defer, mergeMap, of, Subject } from "rxjs";
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
 * What the wrapper adds is that an answer NestJS or Fastify would read after
 * the handler returned, outside the scope, is refused: an Observable, whose
 * operators run wherever a value is emitted, and a stream. So each case calls
 * the handler inside the scope, as the router does, and checks that nothing
 * subscribed to what it returned.
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

  it("refuses an Observable it returns, before anything subscribes to it", () => {
    // A Subject the plugin shares, which a job would feed outside the scope.
    const events = new Subject<number>();
    let produced = false;

    expect(() =>
      served(() =>
        defer(() => {
          produced = true;
          return of(seen());
        }),
      ),
    ).toThrow(/answered with an Observable or a stream/);
    expect(() => served(() => events.pipe(mergeMap(() => of(seen()))))).toThrow(
      /answered with an Observable or a stream/,
    );
    expect(produced).toBe(false);
    expect(events.observed).toBe(false);
  });

  it("refuses an Observable an async handler or a thenable resolves to", async () => {
    // A Subject the plugin shares, which a job would feed outside the scope.
    const events = new Subject<number>();
    const thenable = {
      // oxlint-disable-next-line unicorn/no-thenable -- the shape under test
      then(resolve: (value: unknown) => void): void {
        resolve(events.pipe(mergeMap(() => of(seen()))));
      },
    };

    await expect(
      served(async () => events.pipe(mergeMap(() => of(seen())))),
    ).rejects.toThrow(/answered with an Observable or a stream/);
    await expect(served(() => thenable)).rejects.toThrow(
      /answered with an Observable or a stream/,
    );
    expect(events.observed).toBe(false);
  });

  it.each([
    ["a StreamableFile", () => new StreamableFile(Readable.from(["x"]))],
    ["a Node stream", () => Readable.from(["x"])],
    ["a web stream", () => new ReadableStream()],
    ["a Response", () => new Response("x")],
  ])(
    "refuses %s, which Fastify reads after it has returned",
    async (_kind, answer) => {
      expect(() => served(answer)).toThrow(
        /answered with an Observable or a stream/,
      );
      await expect(served(async () => answer())).rejects.toThrow(
        /answered with an Observable or a stream/,
      );
    },
  );

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

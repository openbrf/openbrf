import { Readable } from "node:stream";

import { StreamableFile } from "@nestjs/common";
import { defer, firstValueFrom, mergeMap, of, Subject } from "rxjs";
import { describe, expect, it } from "vite-plus/test";

import {
  markResidentRoute,
  residentRouteHandler,
  residentRouteOf,
  residentRouteOfHostCall,
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

  describe("a host call the scope narrows, made outside it while the handler awaits", () => {
    /**
     * A handler that awaits a listener on a Subject the plugin shares, as
     * `firstValueFrom(events.pipe(mergeMap(() => host.addressBook.residents())))`
     * does: the listener makes the host's narrowed call wherever the value is
     * emitted, and answers with what it read.
     */
    function awaiting(events: Subject<number>, pluginId = PLUGIN) {
      return async () => ({
        names: await firstValueFrom(
          events.pipe(
            mergeMap(async () => {
              residentRouteOfHostCall(pluginId);
              return ["Granne"];
            }),
          ),
        ),
      });
    }

    it("fails the answer when a job or another request emits", async () => {
      const events = new Subject<number>();
      const answer = served(awaiting(events));

      // Emitted outside the scope, as a job or a board route emits.
      events.next(1);

      await expect(answer).rejects.toThrow(/outside any resident route/);
    });

    it("fails the answer of every resident route of the plugin's yet to answer", async () => {
      const events = new Subject<number>();
      const first = served(awaiting(events));
      const second = served(awaiting(events));

      events.next(1);

      await expect(first).rejects.toThrow(/outside any resident route/);
      await expect(second).rejects.toThrow(/outside any resident route/);
    });

    it("fails nothing when emitted on a resident route of the plugin's, or for another plugin", async () => {
      const events = new Subject<number>();
      const other = new Subject<number>();
      const answer = served(awaiting(events));
      const otherPlugins = served(awaiting(other, "another-plugin"));

      runOnResidentRoute({ ...scope, request: {}, personId: "person-2" }, () =>
        events.next(1),
      );
      other.next(1);

      await expect(answer).resolves.toEqual({ names: ["Granne"] });
      await expect(otherPlugins).resolves.toEqual({ names: ["Granne"] });
    });

    it("fails no answer given before the call, nor one asked for after it", async () => {
      const given = await (served(async () => ({
        offers: [],
      })) as Promise<unknown>);
      const thrown = (): never => {
        throw new Error("The plugin's own failure.");
      };
      expect(() => served(thrown)).toThrow(/plugin's own failure/);

      residentRouteOfHostCall(PLUGIN);
      const later = served(async () => ({ offers: [] }));

      expect(given).toEqual({ offers: [] });
      await expect(later).resolves.toEqual({ offers: [] });
    });
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

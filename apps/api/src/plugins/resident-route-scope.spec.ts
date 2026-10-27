import { Readable } from "node:stream";

import {
  ConflictException,
  HttpException,
  StreamableFile,
} from "@nestjs/common";
import { PluginResidentRouteError } from "@openbrf/plugin-sdk";
import { defer, firstValueFrom, mergeMap, of, Subject } from "rxjs";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  markResidentRoute,
  RESIDENT_ROUTE_ANSWER_WAIT_MS,
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
 * operators run wherever a value is emitted, and a stream. Any other answer is
 * taken as data inside the scope. And until the handler has answered, a host
 * call the scope narrows that is made outside it waits. So each case calls the
 * handler inside the scope, as the router does.
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

  describe("a host call the scope narrows, made outside it while the handler works", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    /**
     * A handler that awaits a listener on a Subject the plugin shares, as
     * `firstValueFrom(events.pipe(mergeMap(() => host.addressBook.residents())))`
     * does: the listener makes the host's narrowed call wherever the value is
     * emitted, and `work` stands for what the call does once it may.
     */
    function awaiting(
      events: Subject<number>,
      work: () => void,
      pluginId = PLUGIN,
    ) {
      return async () => ({
        names: await firstValueFrom(
          events.pipe(
            mergeMap(async () => {
              await residentRouteOfHostCall(pluginId, "addressBook.residents");
              work();
              return ["Granne"];
            }),
          ),
        ),
      });
    }

    /** A handler that answers when `answer` is called. */
    function answeringWhenTold() {
      let answer = (): void => undefined;
      const told = new Promise<void>((resolve) => {
        answer = resolve;
      });
      return {
        handler: async () => {
          await told;
          return { offers: [] };
        },
        answer,
      };
    }

    it("refuses the call before it does anything when a job or another request emits", async () => {
      vi.useFakeTimers();
      const events = new Subject<number>();
      let ran = false;
      const answer = served(
        awaiting(events, () => {
          ran = true;
        }),
      ) as Promise<unknown>;
      const settled = answer.catch((cause: unknown) => cause);

      // Emitted outside the scope, as a job or a board route emits.
      events.next(1);
      await vi.advanceTimersByTimeAsync(RESIDENT_ROUTE_ANSWER_WAIT_MS - 1);
      expect(ran).toBe(false);
      await vi.advanceTimersByTimeAsync(1);

      expect(await settled).toEqual(
        new PluginResidentRouteError(PLUGIN, "addressBook.residents", true),
      );
      expect(ran).toBe(false);
    });

    it("holds a call made elsewhere until the handler has answered, and then lets it go ahead", async () => {
      const { handler, answer } = answeringWhenTold();
      const order: string[] = [];
      const given = (served(handler) as Promise<unknown>).then(() =>
        order.push("answered"),
      );

      const call = residentRouteOfHostCall(
        PLUGIN,
        "addressBook.residents",
      ).then((scope) =>
        order.push(scope === null ? "call" : "call on a route"),
      );
      await Promise.resolve();
      expect(order).toEqual([]);
      answer();
      await Promise.all([given, call]);

      expect(order).toEqual(["answered", "call"]);
    });

    it("takes a handler's failure as its answer", async () => {
      const thrown = (): never => {
        throw new Error("The plugin's own failure.");
      };
      expect(() => served(thrown)).toThrow(/plugin's own failure/);
      await expect(
        served(async () => thrown()) as Promise<unknown>,
      ).rejects.toThrow(/plugin's own failure/);

      await expect(
        residentRouteOfHostCall(PLUGIN, "addressBook.residents"),
      ).resolves.toBeNull();
    });

    it("does not hold a call on a resident route of the plugin's, nor one for another plugin", async () => {
      const { handler, answer } = answeringWhenTold();
      const pending = served(handler) as Promise<unknown>;
      const another = { ...scope, request: {}, personId: "person-2" };

      await expect(
        runOnResidentRoute(another, () =>
          residentRouteOfHostCall(PLUGIN, "addressBook.residents"),
        ),
      ).resolves.toBe(another);
      await expect(
        residentRouteOfHostCall("another-plugin", "addressBook.residents"),
      ).resolves.toBeNull();
      answer();
      await expect(pending).resolves.toEqual({ offers: [] });
    });

    it("does not wait for a handler begun after the call was made", async () => {
      const call = residentRouteOfHostCall(PLUGIN, "addressBook.residents");
      const { handler, answer } = answeringWhenTold();
      const pending = served(handler) as Promise<unknown>;

      await expect(call).resolves.toBeNull();
      answer();
      await pending;
    });
  });

  describe("the answer it sends", () => {
    it("is the data the answer serializes to, taken inside the scope", async () => {
      const read: (string | null)[] = [];
      const answer = {
        offers: [
          {
            get label() {
              read.push(seen());
              return "Plats 4";
            },
          },
        ],
        claim: {
          toJSON() {
            read.push(seen());
            return { on: "2026-11-02" };
          },
        },
        on: new Date("2026-11-02T00:00:00.000Z"),
      };
      const expected = {
        offers: [{ label: "Plats 4" }],
        claim: { on: "2026-11-02" },
        on: "2026-11-02T00:00:00.000Z",
      };

      const returned = served(() => answer);
      const resolved = await (served(async () => answer) as Promise<unknown>);

      expect(returned).toEqual(expected);
      expect(resolved).toEqual(expected);
      expect(read).toEqual(["person-1", "person-1", "person-1", "person-1"]);
    });

    it("takes the body of an HttpException the handler throws inside the scope", async () => {
      const read: (string | null)[] = [];
      const body = {
        toJSON() {
          read.push(seen());
          return { message: "Taken" };
        },
      };

      const thrown = (() => {
        try {
          served(() => {
            throw new ConflictException(body);
          });
        } catch (cause) {
          return cause;
        }
        return null;
      })();
      const rejected = await (
        served(async () => {
          throw new ConflictException(body);
        }) as Promise<unknown>
      ).catch((cause: unknown) => cause);

      for (const cause of [thrown, rejected]) {
        expect(cause).toBeInstanceOf(HttpException);
        expect((cause as HttpException).getStatus()).toBe(409);
        expect((cause as HttpException).getResponse()).toEqual({
          message: "Taken",
        });
      }
      expect(read).toEqual(["person-1", "person-1"]);
    });

    it("passes a primitive and nothing on as they are", async () => {
      expect(served(() => "Plats 4")).toBe("Plats 4");
      expect(served(() => undefined)).toBeUndefined();
      await expect(served(async () => null) as Promise<unknown>).resolves.toBe(
        null,
      );
    });
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

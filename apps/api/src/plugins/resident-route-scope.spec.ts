import { Readable } from "node:stream";

import {
  ConflictException,
  HttpException,
  StreamableFile,
} from "@nestjs/common";
import { PluginResidentRouteError } from "@openbrf/plugin-sdk";
import { defer, firstValueFrom, mergeMap, of, Subject } from "rxjs";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { ResidentRouteTimedOutError } from "./plugin.errors";
import {
  markResidentRoute,
  RESIDENT_ROUTE_ANSWER_WAIT_MS,
  RESIDENT_ROUTE_DEADLINE_MS,
  RESIDENT_ROUTE_OVERRUN_MS,
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
      refused: (cause: unknown) => void = () => undefined,
    ) {
      return async () => ({
        names: await firstValueFrom(
          events.pipe(
            mergeMap(async () => {
              try {
                await residentRouteOfHostCall(PLUGIN, "addressBook.residents");
              } catch (cause) {
                refused(cause);
                throw cause;
              }
              work();
              return ["Granne"];
            }),
          ),
        ),
      });
    }

    /** What a promise settled with, once it has, or "pending". */
    function outcomeOf(promise: Promise<unknown>): () => unknown {
      let outcome: unknown = "pending";
      promise.then(
        (value: unknown) => {
          outcome = value;
        },
        (cause: unknown) => {
          outcome = cause;
        },
      );
      return () => outcome;
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
      let refused: unknown = null;
      const answer = served(
        awaiting(
          events,
          () => {
            ran = true;
          },
          (cause) => {
            refused = cause;
          },
        ),
      ) as Promise<unknown>;
      const settled = answer.catch((cause: unknown) => cause);

      // Emitted outside the scope, as a job or a board route emits.
      events.next(1);
      await vi.advanceTimersByTimeAsync(RESIDENT_ROUTE_DEADLINE_MS - 1);
      expect(ran).toBe(false);
      expect(refused).toBeNull();
      await vi.advanceTimersByTimeAsync(1);

      // The handler cannot answer while it awaits the call, so its deadline
      // runs out, and the call that waited for it is refused.
      expect(await settled).toBeInstanceOf(ResidentRouteTimedOutError);
      expect(refused).toEqual(
        new PluginResidentRouteError(PLUGIN, "addressBook.residents", true),
      );
      await vi.advanceTimersByTimeAsync(RESIDENT_ROUTE_ANSWER_WAIT_MS);
      expect(ran).toBe(false);
    });

    it("fails a handler that has not answered by its deadline, and refuses the calls that waited for it", async () => {
      vi.useFakeTimers();
      const { handler, answer } = answeringWhenTold();
      const given = outcomeOf(served(handler) as Promise<unknown>);
      const waited = outcomeOf(
        residentRouteOfHostCall(PLUGIN, "actions.invoke"),
      );
      try {
        await vi.advanceTimersByTimeAsync(RESIDENT_ROUTE_DEADLINE_MS - 1);
        expect(given()).toBe("pending");
        expect(waited()).toBe("pending");
        await vi.advanceTimersByTimeAsync(1);

        // Refused at the handler's deadline, before its own wait runs out.
        expect(RESIDENT_ROUTE_DEADLINE_MS).toBeLessThan(
          RESIDENT_ROUTE_ANSWER_WAIT_MS,
        );
        expect(given()).toBeInstanceOf(ResidentRouteTimedOutError);
        expect(waited()).toEqual(
          new PluginResidentRouteError(PLUGIN, "actions.invoke", true),
        );
      } finally {
        answer();
        await vi.advanceTimersByTimeAsync(0);
      }
      // What the handler answers late is dropped.
      expect(given()).toBeInstanceOf(ResidentRouteTimedOutError);
    });

    it("refuses a call made while the work of a handler cut off goes on, until that work settles", async () => {
      vi.useFakeTimers();
      const { handler, answer } = answeringWhenTold();
      void (served(handler) as Promise<unknown>).catch(() => undefined);
      await vi.advanceTimersByTimeAsync(RESIDENT_ROUTE_DEADLINE_MS);

      // A listener the handler awaits, refused at the deadline, makes its next
      // call with the same kept request: refused at once, without a wait.
      const next = outcomeOf(residentRouteOfHostCall(PLUGIN, "actions.invoke"));
      await vi.advanceTimersByTimeAsync(0);
      expect(next()).toEqual(
        new PluginResidentRouteError(PLUGIN, "actions.invoke", true),
      );

      answer();
      await vi.advanceTimersByTimeAsync(0);
      await expect(
        residentRouteOfHostCall(PLUGIN, "actions.invoke"),
      ).resolves.toBeNull();
    });

    it("stops refusing calls for a handler whose work never settles once it has overrun", async () => {
      vi.useFakeTimers();
      const { handler } = answeringWhenTold();
      void (served(handler) as Promise<unknown>).catch(() => undefined);
      await vi.advanceTimersByTimeAsync(
        RESIDENT_ROUTE_DEADLINE_MS + RESIDENT_ROUTE_OVERRUN_MS - 1,
      );
      const late = outcomeOf(residentRouteOfHostCall(PLUGIN, "actions.invoke"));
      await vi.advanceTimersByTimeAsync(0);
      expect(late()).toBeInstanceOf(PluginResidentRouteError);

      await vi.advanceTimersByTimeAsync(1);
      await expect(
        residentRouteOfHostCall(PLUGIN, "actions.invoke"),
      ).resolves.toBeNull();
    });

    it("refuses only the calls that waited for the handler that ran out, not those that waited for one that answered", async () => {
      vi.useFakeTimers();
      const quick = answeringWhenTold();
      const given = outcomeOf(served(quick.handler) as Promise<unknown>);
      const before = outcomeOf(residentRouteOfHostCall(PLUGIN, "audit.record"));
      quick.answer();
      await vi.advanceTimersByTimeAsync(0);

      expect(given()).toEqual({ offers: [] });
      expect(before()).toBeNull();

      const hanging = answeringWhenTold();
      const hung = outcomeOf(served(hanging.handler) as Promise<unknown>);
      const during = outcomeOf(residentRouteOfHostCall(PLUGIN, "audit.record"));
      try {
        await vi.advanceTimersByTimeAsync(RESIDENT_ROUTE_DEADLINE_MS);

        expect(hung()).toBeInstanceOf(ResidentRouteTimedOutError);
        expect(during()).toBeInstanceOf(PluginResidentRouteError);
      } finally {
        hanging.answer();
        await vi.advanceTimersByTimeAsync(0);
      }
    });

    it("refuses at the first deadline to run out, without waiting for a handler begun later that is still within its own", async () => {
      vi.useFakeTimers();
      const first = answeringWhenTold();
      const second = answeringWhenTold();
      void (served(first.handler) as Promise<unknown>).catch(() => undefined);
      await vi.advanceTimersByTimeAsync(1_000);
      void (served(second.handler) as Promise<unknown>).catch(() => undefined);

      // Made while both handlers are within their deadlines, so it waits for
      // both.
      await vi.advanceTimersByTimeAsync(1_000);
      const before = outcomeOf(
        residentRouteOfHostCall(PLUGIN, "actions.invoke"),
      );
      try {
        await vi.advanceTimersByTimeAsync(RESIDENT_ROUTE_DEADLINE_MS - 2_001);
        expect(before()).toBe("pending");

        // The first handler runs out while the second has a second to go: the
        // call is refused then, and not when the second one answers.
        await vi.advanceTimersByTimeAsync(1);
        expect(before()).toEqual(
          new PluginResidentRouteError(PLUGIN, "actions.invoke", true),
        );

        // A call made during the first one's overrun is refused at once too.
        const during = outcomeOf(
          residentRouteOfHostCall(PLUGIN, "actions.invoke"),
        );
        await vi.advanceTimersByTimeAsync(0);
        expect(during()).toEqual(
          new PluginResidentRouteError(PLUGIN, "actions.invoke", true),
        );
      } finally {
        first.answer();
        second.answer();
        await vi.advanceTimersByTimeAsync(0);
      }
      await expect(
        residentRouteOfHostCall(PLUGIN, "actions.invoke"),
      ).resolves.toBeNull();
    });

    it("holds a call made elsewhere until the handler has answered, and then lets it go ahead", async () => {
      vi.useFakeTimers();
      const { handler, answer } = answeringWhenTold();
      const given = outcomeOf(served(handler) as Promise<unknown>);
      const call = outcomeOf(
        residentRouteOfHostCall(PLUGIN, "addressBook.residents"),
      );
      await Promise.resolve();
      expect(given()).toBe("pending");
      expect(call()).toBe("pending");
      answer();
      await vi.advanceTimersByTimeAsync(0);

      // How many ticks apart the two settle is not the guard's to promise: the
      // call goes ahead only once the handler has answered.
      expect(given()).toEqual({ offers: [] });
      expect(call()).toBeNull();
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

    /** What `work` throws or rejects with, run as the router runs a handler. */
    async function failures(work: () => unknown): Promise<unknown[]> {
      let thrown: unknown;
      try {
        served(work);
      } catch (cause) {
        thrown = cause;
      }
      const rejected = await (
        served(async () => work()) as Promise<unknown>
      ).catch((cause: unknown) => cause);
      return [thrown, rejected];
    }

    /** An HttpException whose body records where its `toJSON` runs. */
    function readingException(read: (string | null)[]): HttpException {
      return new ConflictException({
        toJSON() {
          read.push(seen());
          return { message: "Taken" };
        },
      });
    }

    it("takes an HttpException a getter of the answer throws as the handler's own", async () => {
      const read: (string | null)[] = [];
      const answer = {
        get label(): string {
          throw readingException(read);
        },
      };

      const [thrown, rejected] = await failures(() => answer);

      for (const cause of [thrown, rejected]) {
        expect(cause).toBeInstanceOf(HttpException);
        expect((cause as HttpException).getStatus()).toBe(409);
        expect((cause as HttpException).getResponse()).toEqual({
          message: "Taken",
        });
      }
      expect(read).toEqual(["person-1", "person-1"]);
    });

    it("fails with an error of the core's when taking an HttpException throws", async () => {
      const read: (string | null)[] = [];
      const inner = readingException(read);
      const throwingBody = new ConflictException({
        toJSON() {
          throw inner;
        },
      });
      const throwingStatus = new ConflictException("Taken");
      throwingStatus.getStatus = () => {
        throw inner;
      };

      for (const exception of [throwingBody, throwingStatus]) {
        for (const cause of await failures(() => {
          throw exception;
        })) {
          expect(cause).not.toBeInstanceOf(HttpException);
          expect(cause).toEqual(
            new Error(
              `A resident route of plugin "${PLUGIN}" failed with something ` +
                "that could not be taken inside the scope of the request it " +
                "serves.",
            ),
          );
        }
      }
      // The inner exception's body was never taken, here or later.
      expect(read).toEqual([]);
    });

    it("hands any other failure on as a copy, read inside the scope", async () => {
      const read: (string | null)[] = [];
      class OwnError extends Error {
        override name = "OwnError";
        get code(): string {
          read.push(seen());
          return "E_OWN";
        }
      }
      const own = new OwnError("The plugin's own failure.");

      for (const cause of await failures(() => {
        throw own;
      })) {
        expect(cause).not.toBe(own);
        expect(Object.getPrototypeOf(cause)).toBe(Error.prototype);
        expect(cause).toMatchObject({
          name: "OwnError",
          message: "The plugin's own failure.",
          code: "E_OWN",
          stack: own.stack,
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

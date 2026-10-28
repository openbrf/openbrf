import { EventEmitter } from "node:events";

import {
  Body,
  type CanActivate,
  Catch,
  type ExceptionFilter,
  type ArgumentsHost,
  Controller,
  type ExecutionContext,
  Get,
  Module,
  Post,
  Req,
  UseFilters,
  UseGuards,
} from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from "@nestjs/platform-fastify";
import { PluginRequestContextError } from "@openbrf/plugin-sdk";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import {
  heldToContext,
  runServingRequest,
  ServedRequestHook,
  servesRequest,
} from "./served-request";

/**
 * The scope that holds the request the work in progress is serving (ADR 0051,
 * update of 2026-10-28), alone and as the HTTP server opens it.
 */

describe("the served request's scope", () => {
  it("serves the request it was opened for, and no other", () => {
    const request = {};
    const another = {};

    runServingRequest(request, () => {
      expect(servesRequest(request)).toBe(true);
      expect(servesRequest(another)).toBe(false);
      expect(servesRequest(null)).toBe(false);
    });
    expect(servesRequest(request)).toBe(false);
  });

  it("follows the work begun for the request, after it has answered too", async () => {
    const request = {};
    let later: Promise<boolean> = Promise.resolve(false);

    runServingRequest(request, () => {
      later = new Promise((resolve) =>
        setTimeout(() => resolve(servesRequest(request)), 5),
      );
    });

    expect(await later).toBe(true);
  });

  it("does not reach a listener that something outside the request runs", () => {
    // A listener runs where the value is emitted, here in another request's
    // work, whoever set it.
    const request = {};
    const another = {};
    const events = new EventEmitter();
    const heard: boolean[] = [];
    runServingRequest(request, () => {
      events.on("offer", () => heard.push(servesRequest(request)));
    });

    events.emit("offer");
    runServingRequest(another, () => events.emit("offer"));
    runServingRequest(request, () => events.emit("offer"));

    expect(heard).toEqual([false, false, true]);
  });

  it("refuses a member given a request the work is not serving, naming the member alone", () => {
    const request = { id: "req-board-member" };

    expect(() =>
      heldToContext("parking-share", request, "actions.invoke"),
    ).toThrow(PluginRequestContextError);
    runServingRequest({}, () => {
      expect(() =>
        heldToContext("parking-share", request, "addressBook.caller"),
      ).toThrow(
        expect.objectContaining({
          name: "PluginRequestContextError",
          pluginId: "parking-share",
          member: "addressBook.caller",
          message: expect.not.stringContaining("req-board-member"),
        }),
      );
    });
    runServingRequest(request, () => {
      expect(() =>
        heldToContext("parking-share", request, "actions.invoke"),
      ).not.toThrow();
    });
  });
});

/**
 * Through the real router: the hook opens the scope before the first guard,
 * after the body is read, and everything NestJS runs for the request runs in
 * it, an exception filter and the answer's serialization included. A request
 * one route keeps is served by none of the work another request begins.
 */
describe("the scope the HTTP server opens", () => {
  /** What each piece of a request's work found, by the route that ran it. */
  const seen: Record<string, boolean> = {};
  let kept: object | null = null;
  let release = (): void => undefined;
  const events = new EventEmitter();

  class Watching implements CanActivate {
    canActivate(context: ExecutionContext): Promise<boolean> {
      const request = context.switchToHttp().getRequest<object>();
      seen["guard"] = servesRequest(request);
      // A guard that awaits, so the handler runs in a later continuation.
      return new Promise((resolve) => setTimeout(() => resolve(true), 1));
    }
  }

  class Answering implements ExceptionFilter {
    catch(_error: unknown, host: ArgumentsHost): void {
      const http = host.switchToHttp();
      seen["filter"] = servesRequest(http.getRequest<object>());
      http
        .getResponse<{ status(code: number): { send(body: unknown): void } }>()
        .status(418)
        .send({ caught: true });
    }
  }

  class Routes {
    async read(request: object): Promise<object> {
      await new Promise((resolve) => setTimeout(resolve, 1));
      seen["handler"] = servesRequest(request);
      return {
        toJSON: () => {
          seen["serialized"] = servesRequest(request);
          return { read: true };
        },
      };
    }

    async write(request: object, body: unknown): Promise<unknown> {
      seen["post"] = servesRequest(request);
      return body;
    }

    async fail(): Promise<never> {
      await Promise.resolve();
      throw new Error("refused");
    }

    async hold(request: object): Promise<object> {
      kept = request;
      events.on("used", () => {
        seen["listenerElsewhere"] = servesRequest(request);
      });
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return { held: true };
    }

    use(request: object): object {
      events.emit("used");
      return {
        kept: kept !== null && servesRequest(kept),
        own: servesRequest(request),
      };
    }

    free(): object {
      release();
      return { freed: true };
    }
  }

  const decorate = (
    name: keyof Routes,
    route: MethodDecorator,
    params: ParameterDecorator[] = [],
  ): void => {
    const descriptor = Object.getOwnPropertyDescriptor(Routes.prototype, name);
    route(Routes.prototype, name, descriptor as PropertyDescriptor);
    params.forEach((param, index) => {
      param(Routes.prototype, name, index);
    });
  };
  Controller("served")(Routes);
  UseGuards(Watching)(Routes);
  Catch()(Answering);
  UseFilters(Answering)(Routes);
  decorate("read", Get("read"), [Req()]);
  decorate("write", Post("write"), [Req(), Body()]);
  decorate("fail", Get("fail"));
  decorate("hold", Get("hold"), [Req()]);
  decorate("use", Get("use"), [Req()]);
  decorate("free", Get("free"));

  class ServedModule {}
  Module({ controllers: [Routes], providers: [ServedRequestHook] })(
    ServedModule,
  );

  let app: NestFastifyApplication;

  beforeAll(async () => {
    app = await NestFactory.create<NestFastifyApplication>(
      ServedModule,
      new FastifyAdapter(),
      { logger: false },
    );
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app.close();
  });

  const inject = (method: "GET" | "POST", url: string, payload?: object) =>
    app.getHttpAdapter().getInstance().inject({ method, url, payload });

  it("covers the guard, the handler and the answer's serialization", async () => {
    const response = await inject("GET", "/served/read");

    expect(response.json()).toEqual({ read: true });
    expect(seen).toMatchObject({
      guard: true,
      handler: true,
      serialized: true,
    });
  });

  it("is open once a request's body is read", async () => {
    const response = await inject("POST", "/served/write", { offer: 4 });

    expect(response.json()).toEqual({ offer: 4 });
    expect(seen["post"]).toBe(true);
  });

  it("covers an exception filter", async () => {
    const response = await inject("GET", "/served/fail");

    expect(response.statusCode).toBe(418);
    expect(seen["filter"]).toBe(true);
  });

  it("serves a request kept by one route to none of another request's work", async () => {
    const held = inject("GET", "/served/hold");
    for (let attempt = 0; kept === null && attempt < 200; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    const used = await inject("GET", "/served/use");
    await inject("GET", "/served/free");

    expect(used.json()).toEqual({ kept: false, own: true });
    // The listener the held request set ran in the other request's work.
    expect(seen["listenerElsewhere"]).toBe(false);
    expect((await held).json()).toEqual({ held: true });
  });
});

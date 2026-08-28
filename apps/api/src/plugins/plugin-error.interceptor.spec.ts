import {
  type CallHandler,
  type ExecutionContext,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { firstValueFrom, throwError } from "rxjs";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PluginErrorInterceptor } from "./plugin-error.interceptor";
import { PLUGIN_ID_METADATA } from "./plugin-module-seal";
import { PluginHandlerError } from "./plugin.errors";

/**
 * The sink for every unexpected throw out of a plugin's handler.
 *
 * A plugin runs in this process but is not this product's code, so its failure
 * is answered as a bad gateway and logged as the plugin's rather than the
 * application's. What must not travel with it is the thrown payload: a plugin
 * reading the register through its consented host services can put a
 * resident's address, contact details or a personal identity number into an
 * error message. Protected personal data is masked server-side and every
 * reveal is audit-logged in the same transaction as the read, so a copy in an
 * unstructured application log is a disclosure to anyone with log access and a
 * retention breach at the same time.
 */

const REVEALING_MESSAGE =
  "no apartment for anna.andersson@exempel.se (19850101-1234)";

function contextFor(pluginId: string | undefined): ExecutionContext {
  class OccupancyController {}
  const handler = function report(): void {
    return undefined;
  };
  if (pluginId !== undefined) {
    Reflect.defineMetadata(PLUGIN_ID_METADATA, pluginId, OccupancyController);
  }

  return {
    getClass: () => OccupancyController,
    getHandler: () => handler,
  } as unknown as ExecutionContext;
}

function handlerThrowing(cause: unknown): CallHandler {
  return { handle: () => throwError(() => cause) };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the plugin error interceptor", () => {
  it("keeps the plugin's message out of the log", async () => {
    const logged = vi
      .spyOn(Logger.prototype, "error")
      .mockImplementation(() => undefined);
    const interceptor = new PluginErrorInterceptor(new Reflector());

    await expect(
      firstValueFrom(
        interceptor.intercept(
          contextFor("occupancy"),
          handlerThrowing(new TypeError(REVEALING_MESSAGE)),
        ),
      ),
    ).rejects.toBeInstanceOf(PluginHandlerError);

    expect(logged).toHaveBeenCalledOnce();
    const written = JSON.stringify(logged.mock.calls[0]);
    expect(written).not.toContain("anna.andersson@exempel.se");
    expect(written).not.toContain("19850101-1234");
    // The identity is still there, so an operator can tell whose bug it is.
    expect(written).toContain("occupancy");
    expect(written).toContain("TypeError");
  });

  it("keeps the message out of the stack it logs", async () => {
    // A V8 stack begins with "Name: message", so logging the whole stack would
    // put the payload back in by another route.
    const logged = vi
      .spyOn(Logger.prototype, "error")
      .mockImplementation(() => undefined);
    const interceptor = new PluginErrorInterceptor(new Reflector());

    await expect(
      firstValueFrom(
        interceptor.intercept(
          contextFor("occupancy"),
          handlerThrowing(new Error(REVEALING_MESSAGE)),
        ),
      ),
    ).rejects.toBeInstanceOf(PluginHandlerError);

    const frames = logged.mock.calls[0]?.[1];
    expect(typeof frames).toBe("string");
    expect(frames as string).not.toContain(REVEALING_MESSAGE);
    expect(
      (frames as string)
        .split("\n")
        .every((line) => line.trimStart().startsWith("at ")),
    ).toBe(true);
  });

  it("leaves an HttpException a plugin threw on purpose alone", async () => {
    // A plugin answering 404 for a resource of its own has said what it meant.
    const interceptor = new PluginErrorInterceptor(new Reflector());
    const thrown = new NotFoundException("no such report");

    await expect(
      firstValueFrom(
        interceptor.intercept(contextFor("occupancy"), handlerThrowing(thrown)),
      ),
    ).rejects.toBe(thrown);
  });

  it("does not touch a route that is not a plugin's", async () => {
    const interceptor = new PluginErrorInterceptor(new Reflector());
    const thrown = new Error("a fault in the application itself");

    await expect(
      firstValueFrom(
        interceptor.intercept(contextFor(undefined), handlerThrowing(thrown)),
      ),
    ).rejects.toBe(thrown);
  });
});

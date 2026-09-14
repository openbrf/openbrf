import { describe, expect, it } from "vitest";

import { ActionCallerFactory, type RequestWithToken } from "./action-caller";
import { markAuthenticated } from "./authenticated-request";

/**
 * The handle a call is decided on.
 *
 * A plugin holds the same dispatch surface the platform does, so the question
 * these tests answer is not "does it work" but "can a plugin name somebody it
 * was not given". Two ways it could: by handing over a caller it built, and by
 * handing over a request it built. Both are refused here.
 */

function authenticatedRequest(
  personId: string,
  token?: RequestWithToken["token"],
): RequestWithToken {
  const request = {
    id: "req-1",
    principal: { personId, capabilities: new Set<string>() },
    ...(token === undefined ? {} : { token }),
  } as unknown as RequestWithToken;
  markAuthenticated(request);
  return request;
}

describe("what a caller may be minted from", () => {
  it("refuses a request the platform never authenticated", () => {
    // The impersonation this closes: a plugin passing an object of its own
    // with a principal on it, rather than the request its route received.
    const factory = new ActionCallerFactory();
    const forged = {
      id: "req-1",
      principal: { personId: "somebody-else", capabilities: new Set<string>() },
    } as unknown as RequestWithToken;

    expect(() => factory.forRequest(forged)).toThrow(/not a request/i);
  });

  it("refuses a handle it did not issue", () => {
    // And the other half: a literal shaped like a caller. The handle carries
    // nothing, so there is nothing to copy.
    const factory = new ActionCallerFactory();

    expect(() => factory.resolve({} as never)).toThrow(/not a caller/i);
  });
});

describe("what the channel is derived from", () => {
  it("reads a cookie request as the web interface", () => {
    const factory = new ActionCallerFactory();

    const resolved = factory.resolve(
      factory.forRequest(authenticatedRequest("person-1")),
    );

    expect(resolved.channel).toBe("web");
    expect(resolved.client).toBeNull();
    expect(resolved.scopes).toEqual([]);
  });

  it("reads a request carrying a token as a connected app", () => {
    const factory = new ActionCallerFactory();

    const resolved = factory.resolve(
      factory.forRequest(
        authenticatedRequest("person-1", {
          clientId: "client-1",
          clientHost: "claude.ai",
          scopes: ["mcp:read"],
        }),
      ),
    );

    expect(resolved.channel).toBe("mcp");
    expect(resolved.client).toEqual({
      clientId: "client-1",
      clientHost: "claude.ai",
    });
    expect(resolved.scopes).toEqual(["mcp:read"]);
  });

  it("reads a plugin dispatching for a signed-in person as the plugin", () => {
    // The write is the plugin's, made while serving that person. The log says
    // so rather than reading as though the person did it in a browser.
    const factory = new ActionCallerFactory();

    const resolved = factory.resolve(
      factory.forPlugin(authenticatedRequest("person-1")),
    );

    expect(resolved.channel).toBe("plugin");
  });

  it("keeps the connected app's channel when a token reaches a plugin route", () => {
    // A token on a plugin's route is still the connected app reaching the
    // records, and that is what the entry has to say.
    const factory = new ActionCallerFactory();

    const resolved = factory.resolve(
      factory.forPlugin(
        authenticatedRequest("person-1", {
          clientId: "client-1",
          clientHost: null,
          scopes: ["mcp:write"],
        }),
      ),
    );

    expect(resolved.channel).toBe("mcp");
  });

  it("names a job as the system, with the run in the request id", () => {
    const factory = new ActionCallerFactory();

    const resolved = factory.resolve(
      factory.forSystem("person-1", "nightly-purge"),
    );

    expect(resolved.channel).toBe("system");
    expect(resolved.requestId).toBe("system:nightly-purge");
  });
});

describe("what a holder of the handle can change", () => {
  it("nothing: the facts are held here, not on the handle", () => {
    const factory = new ActionCallerFactory();
    const caller = factory.forRequest(authenticatedRequest("person-1"));

    // Whatever is written onto the handle, the answer comes from the WeakMap
    // this module owns.
    Object.assign(caller, { personId: "somebody-else", channel: "system" });

    expect(factory.resolve(caller).personId).toBe("person-1");
    expect(factory.resolve(caller).channel).toBe("web");
  });
});

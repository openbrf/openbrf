import { Injectable } from "@nestjs/common";
import type { ActionChannel, ActionClient } from "@openbrf/plugin-sdk";

import type { RequestWithPrincipal } from "../authorization/authorization.guard";
import { isAuthenticatedRequest } from "./authenticated-request";

/**
 * Who is calling, as a handle rather than as a description.
 *
 * `invoke()` does not take a person id, a channel or a client. It takes one of
 * these, and only core can mint one. The difference matters because a plugin
 * holds the same dispatch surface the platform does: if the call took a context
 * literal, a plugin could name any person and any channel, and the capability
 * check inside the registry would faithfully answer the question for somebody
 * who never asked it.
 *
 * The handle carries nothing. What it identifies is held here, in a WeakSet
 * this module owns, so the facts a call is decided on are the facts the guard
 * established and are unreachable from anything holding the handle.
 */

declare const brand: unique symbol;

export interface ActionCaller {
  readonly [brand]: true;
}

/** What resolve() returns: the facts the guard established, and nothing else. */
export interface ResolvedCaller {
  readonly personId: string;
  readonly channel: ActionChannel;
  readonly client: ActionClient | null;
  /** The scopes on the token, for a caller that presented one. */
  readonly scopes: readonly string[];
  readonly requestId: string;
}

/**
 * A request the Bearer path authenticated.
 *
 * Written by the guard beside the principal, and read here. Declared as its own
 * shape rather than widening RequestWithPrincipal, because a cookie request
 * never carries one and nothing should be tempted to read it optimistically.
 */
export interface RequestWithToken extends RequestWithPrincipal {
  token?: {
    clientId: string;
    clientHost: string | null;
    scopes: readonly string[];
  };
}

@Injectable()
export class ActionCallerFactory {
  private readonly minted = new WeakMap<object, ResolvedCaller>();

  /**
   * From a request the guard has authenticated.
   *
   * The channel is derived from how the request arrived rather than passed in:
   * a request carrying a token is a connected app, one carrying a session is a
   * person in the web interface. That is what makes the channel evidence.
   */
  forRequest(request: RequestWithToken): ActionCaller {
    if (!isAuthenticatedRequest(request)) {
      throw new Error("This is not a request the platform authenticated.");
    }
    const principal = request.principal;
    if (principal === undefined) {
      throw new Error("The authorization guard did not attach a principal.");
    }

    const token = request.token;
    const handle = {} as ActionCaller;
    this.minted.set(handle, {
      personId: principal.personId,
      channel: token === undefined ? "web" : "mcp",
      client:
        token === undefined
          ? null
          : { clientId: token.clientId, clientHost: token.clientHost },
      scopes: token?.scopes ?? [],
      requestId: request.id,
    });
    return handle;
  }

  /**
   * For a job or a seed: no person asked, and the clock struck.
   *
   * `reason` names the job in the request id, so a refusal in the log can be
   * traced to the run that caused it.
   */
  forSystem(personId: string, reason: string): ActionCaller {
    const handle = {} as ActionCaller;
    this.minted.set(handle, {
      personId,
      channel: "system",
      client: null,
      scopes: [],
      requestId: `system:${reason}`,
    });
    return handle;
  }

  /**
   * For a plugin dispatching in process, on behalf of the request its own route
   * received.
   */
  forPlugin(request: RequestWithToken): ActionCaller {
    const caller = this.forRequest(request);
    const resolved = this.minted.get(caller);
    if (resolved === undefined) {
      throw new Error("A caller minted here was not recorded.");
    }
    this.minted.set(caller, {
      ...resolved,
      // A plugin's own route serving a cookie request is still the plugin
      // writing, and the log should say so. A token on that route keeps its
      // own channel: the connected app is what reached the records.
      channel: resolved.channel === "web" ? "plugin" : resolved.channel,
    });
    return caller;
  }

  /**
   * The facts behind a handle.
   *
   * Refuses anything this factory did not mint, so a literal shaped like a
   * caller is a refusal rather than an impersonation.
   */
  resolve(caller: ActionCaller): ResolvedCaller {
    const resolved = this.minted.get(caller);
    if (resolved === undefined) {
      throw new Error("This is not a caller the platform issued.");
    }
    return resolved;
  }
}

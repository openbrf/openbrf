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
  /**
   * The pending change this call confirms, for a call that confirms one.
   *
   * Set only by {@link ActionCallerFactory.forConfirmation}, so the link an
   * audit entry carries back to the proposal is core's evidence rather than
   * anything a caller said.
   */
  readonly pendingChangeId: string | null;
}

/**
 * A request the Bearer path authenticated.
 *
 * The same shape the guard writes, named here for what it means at this call
 * site. Its one definition is on the guard, because the guard is the only
 * thing that may write it: a second declaration would be a second opinion
 * about what a token established, and the two would be free to drift.
 *
 * The property stays optional because a cookie request never carries one, and
 * its absence is what `forRequest` reads to decide the channel.
 */
export type RequestWithToken = RequestWithPrincipal;

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
      pendingChangeId: null,
    });
    return handle;
  }

  /**
   * For a person confirming a pending change in the web interface (ADR 0039).
   *
   * The confirmed call is theirs, on `web`, whoever proposed it and however it
   * was proposed. A request carrying a token is refused: a connected app may
   * not confirm what a person is meant to have seen, and the routes that
   * confirm take the session cookie only, so reaching this throw means a
   * route was mounted where it should not have been.
   */
  forConfirmation(
    request: RequestWithToken,
    pendingChangeId: string,
  ): ActionCaller {
    if (request.token !== undefined) {
      throw new Error("A pending change is confirmed in the web interface.");
    }
    const caller = this.forRequest(request);
    const resolved = this.resolve(caller);
    this.minted.set(caller, { ...resolved, pendingChangeId });
    return caller;
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
      pendingChangeId: null,
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

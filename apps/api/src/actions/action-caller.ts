import { Injectable } from "@nestjs/common";
import type { ActionChannel, ActionClient } from "@openbrf/plugin-sdk";

import type { RequestWithPrincipal } from "../authorization/authorization.guard";
import { authenticatedFacts } from "./authenticated-request";

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
  /**
   * The channel the pending change it confirms was proposed on.
   *
   * Set with `pendingChangeId` and only then. The confirmed call runs on
   * `web`, where a plugin's action needs no arming; an action an app or a
   * model proposed was offered to it only because an administrator had armed
   * it, and the registry asks again whether it still is (ADR 0039, §3).
   */
  readonly proposedOn: ActionChannel | null;
}

/**
 * A request the Bearer path authenticated.
 *
 * The same shape the guard writes, named here for what it means at this call
 * site. Its one definition is on the guard, because the guard is the only
 * thing that may write it: a second declaration would be a second opinion
 * about what a token established, and the two would be free to drift.
 *
 * The property stays optional because a cookie request never carries one. It
 * is not what `forRequest` reads: a plugin holds the request and can write the
 * property, so the channel is decided from the copy the guard kept with its
 * mark.
 */
export type RequestWithToken = RequestWithPrincipal;

/**
 * What the channel of a plugin's dispatch is derived from, besides the request.
 *
 * One fact from the plugin's manifest: whether it declared itself an AI
 * package. Read by the host, from the manifest the board consented to.
 */
export interface PluginDispatcher {
  readonly ai: boolean;
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
   *
   * Every fact is read from what the guard recorded when it authenticated the
   * request, never from the request's own properties. A plugin's route is
   * handed the real request and can write `principal`, `token` and `id` on it
   * before it dispatches; none of that reaches a caller.
   */
  forRequest(request: RequestWithToken): ActionCaller {
    const facts = authenticatedFacts(request);
    if (facts === undefined) {
      throw new Error("This is not a request the platform authenticated.");
    }

    const token = facts.token;
    const handle = {} as ActionCaller;
    this.minted.set(handle, {
      personId: facts.personId,
      channel: token === null ? "web" : "mcp",
      client:
        token === null
          ? null
          : { clientId: token.clientId, clientHost: token.clientHost },
      scopes: token?.scopes ?? [],
      requestId: facts.requestId,
      pendingChangeId: null,
      proposedOn: null,
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
   *
   * The channel the change was proposed on travels with it, so the registry
   * can hold the call to the arming that channel needed.
   */
  forConfirmation(
    request: RequestWithToken,
    pendingChange: { readonly id: string; readonly proposedOn: ActionChannel },
  ): ActionCaller {
    const caller = this.forRequest(request);
    const resolved = this.resolve(caller);
    if (resolved.channel !== "web") {
      throw new Error("A pending change is confirmed in the web interface.");
    }
    this.minted.set(caller, {
      ...resolved,
      pendingChangeId: pendingChange.id,
      proposedOn: pendingChange.proposedOn,
    });
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
      proposedOn: null,
    });
    return handle;
  }

  /**
   * For a plugin dispatching in process, on behalf of the request its own route
   * received.
   *
   * `plugin` is what the host knows about the plugin from the manifest the
   * board consented to, never something the plugin passed with the call: the
   * host's dispatch reads it from the plugin's own context, and a plugin's
   * `host.actions` takes no channel at all.
   */
  forPlugin(request: RequestWithToken, plugin: PluginDispatcher): ActionCaller {
    const caller = this.forRequest(request);
    const resolved = this.minted.get(caller);
    if (resolved === undefined) {
      throw new Error("A caller minted here was not recorded.");
    }
    this.minted.set(caller, {
      ...resolved,
      // A plugin's own route serving a cookie request is still the plugin
      // writing, and the log should say so: as the AI package where the
      // manifest declares one, and as a plugin otherwise. A token on that route
      // keeps its own channel: the connected app is what reached the records.
      channel:
        resolved.channel === "web"
          ? plugin.ai
            ? "ai"
            : "plugin"
          : resolved.channel,
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

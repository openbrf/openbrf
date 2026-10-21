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
  /**
   * The plugin whose route dispatched, for a caller minted by
   * {@link ActionCallerFactory.forPlugin}. The host names it from the plugin it
   * built the host object for, never from anything the plugin passes.
   */
  readonly pluginId: string | null;
  /** The scopes on the token, for a caller that presented one. */
  readonly scopes: readonly string[];
  readonly requestId: string;
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
 * Two facts from the plugin's manifest: its id, which the audit entry names,
 * and whether it declared itself an AI package. Read by the host, from the
 * manifest the board consented to.
 */
export interface PluginDispatcher {
  readonly id: string;
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
      pluginId: null,
      scopes: token?.scopes ?? [],
      requestId: facts.requestId,
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
      pluginId: null,
      scopes: [],
      requestId: `system:${reason}`,
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
   *
   * The audit entry names the plugin by its id whatever the channel, so an
   * entry written through a plugin's route says which plugin was in between, as
   * one written by a connected app says which app.
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
      pluginId: plugin.id,
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

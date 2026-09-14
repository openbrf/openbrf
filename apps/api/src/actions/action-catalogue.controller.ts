import { Controller, Get, Param, Query, Req } from "@nestjs/common";
import type { ActionSummary } from "@openbrf/plugin-sdk";
import type { FastifyReply } from "fastify";
import { Res } from "@nestjs/common";
import { z } from "zod";

import type { RequestWithPrincipal } from "../authorization/authorization.guard";
import { ActionCallerFactory } from "./action-caller";
import { ActionRegistryService } from "./action-registry.service";
import { ACTION_ERROR_MCP, ActionError } from "./action.error";

/**
 * What this caller may ask the platform to do, in their own language.
 *
 * Gated on a valid session and on nothing more. It is deliberately NOT
 * `@Public()`: an unauthenticated catalogue would tell the internet which
 * plugins a named cooperative has installed, which is a fact about the
 * association rather than about the platform.
 *
 * Entries are filtered to what the caller could actually call, so the list is
 * never a set of things to be refused. That filtering is what makes the
 * response private: two people on the same instance are served different
 * lists, and a cache that did not know it would hand one person the other's.
 *
 * The text is resolved here rather than sent as keys. `packages/i18n` is
 * private, so a third-party connector cannot depend on it, and the only i18n
 * route in the product serves a plugin's own namespace behind a capability a
 * connector does not hold. Keys travel too, for a caller that has them.
 */

const listQuerySchema = z.object({
  surface: z.enum(["ui", "mcp", "ai"]).optional(),
  group: z.string().min(1).max(64).optional(),
});

const nameSchema = z.object({ name: z.string().min(1).max(64) });

export interface ActionCatalogue {
  /**
   * How long this list may be held, in milliseconds, and by whom.
   *
   * Zero and "private" together: the list depends on what the person may do
   * right now, and a board term ending changes it the same night. The MCP
   * caching rule makes both mandatory on a complete tools listing, and
   * "private" is the only honest answer for an authorization-filtered one.
   */
  ttlMs: number;
  cacheScope: "private";
  actions: ActionSummary[];
}

@Controller("api/actions")
export class ActionCatalogueController {
  constructor(
    private readonly registry: ActionRegistryService,
    private readonly callers: ActionCallerFactory,
  ) {}

  @Get()
  async list(
    @Query() query: unknown,
    @Req() request: RequestWithPrincipal,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<ActionCatalogue> {
    const filter = listQuerySchema.parse(query);
    // The header as well as the body: a shared cache in front of the instance
    // reads this one, and knows nothing about the field below it.
    void reply.header("cache-control", "private, no-store");

    const actions = await this.registry.list(
      this.callers.forRequest(request),
      filter,
      request.headers["accept-language"],
    );
    return { ttlMs: 0, cacheScope: "private", actions };
  }

  /**
   * One action, with the schemas a caller needs to call it.
   *
   * Refuses a name the caller could not call with the same answer it gives for
   * a name that does not exist, so the endpoint cannot be used to ask which
   * actions an instance has.
   */
  @Get(":name")
  async byName(
    @Param() params: unknown,
    @Req() request: RequestWithPrincipal,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<
    ActionSummary & {
      inputSchema: Record<string, unknown>;
      outputSchema: Record<string, unknown>;
      errorHandling: typeof ACTION_ERROR_MCP;
    }
  > {
    const { name } = nameSchema.parse(params);
    void reply.header("cache-control", "private, no-store");

    const offered = await this.registry.list(
      this.callers.forRequest(request),
      undefined,
      request.headers["accept-language"],
    );
    const summary = offered.find((action) => action.name === name);
    if (summary === undefined) {
      throw new ActionError("unknown-action", "No such action.");
    }

    return {
      ...summary,
      inputSchema: this.registry.inputJsonSchema(name),
      outputSchema: this.registry.outputJsonSchema(name),
      // Published as data so a connector does not re-derive what a refusal
      // means from its status, and so two connectors cannot disagree about
      // whether a 403 is worth retrying.
      errorHandling: ACTION_ERROR_MCP,
    };
  }
}

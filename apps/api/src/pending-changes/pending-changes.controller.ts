import { Controller, Get, HttpCode, Param, Post, Req } from "@nestjs/common";
import { z } from "zod";

import type { RequestWithPrincipal } from "../authorization/authorization.guard";
import { requirePrincipal } from "../authorization/require-principal";
import {
  type PendingChangeView,
  PendingChangeService,
} from "./pending-change.service";

/** A pending change's id, as the routes take it. */
const idSchema = z.strictObject({ id: z.string().min(1).max(64) });

/**
 * A person's own pending changes, and confirming or rejecting one.
 *
 * No capability on the routes. A pending change is its proposer's and nobody
 * else's, every query is keyed on the person, and whether they may do what a
 * change holds is decided when they confirm it, by the action registry, against
 * the action's own capability and their standing at that moment. A capability
 * here would be a second opinion that could only disagree. What the preview
 * reads beyond the change itself - the names beside the ids in its input - is
 * read only for a person who holds that feature's capability now, so the
 * principal travels with the reads.
 *
 * The session cookie only: the global guard answers a token on no route but the
 * connector's, so a connected app cannot reach these, and confirming is a
 * person on the platform's own screen by construction. A plugin's own route
 * proposes through `host.actions.propose` and has no way to confirm.
 */
@Controller("api/pending-changes/mine")
export class PendingChangesController {
  constructor(private readonly changes: PendingChangeService) {}

  @Get()
  async mine(
    @Req() request: RequestWithPrincipal,
  ): Promise<{ pendingChanges: PendingChangeView[] }> {
    return {
      pendingChanges: await this.changes.mine(
        requirePrincipal(request),
        request.headers["accept-language"],
      ),
    };
  }

  @Get(":id")
  async one(
    @Req() request: RequestWithPrincipal,
    @Param() params: unknown,
  ): Promise<PendingChangeView> {
    const { id } = idSchema.parse(params);
    return this.changes.one(
      requirePrincipal(request),
      id,
      request.headers["accept-language"],
    );
  }

  /*
   * 200 rather than POST's default 201, here and on reject: neither creates a
   * resource at an address. Whatever the held action created is that action's
   * own, and the pending change itself is gone.
   */
  @Post(":id/confirm")
  @HttpCode(200)
  async confirm(
    @Req() request: RequestWithPrincipal,
    @Param() params: unknown,
  ): Promise<{ confirmed: true }> {
    const { id } = idSchema.parse(params);
    await this.changes.confirm(request, id);
    return { confirmed: true };
  }

  @Post(":id/reject")
  @HttpCode(200)
  async reject(
    @Req() request: RequestWithPrincipal,
    @Param() params: unknown,
  ): Promise<{ rejected: true }> {
    const { id } = idSchema.parse(params);
    await this.changes.reject(request, id);
    return { rejected: true };
  }
}

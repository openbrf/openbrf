import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  Req,
} from "@nestjs/common";
import type {
  CreatedGroupView,
  GroupCandidateView,
  GroupMemberView,
} from "@openbrf/shared";
import { z } from "zod";

import type { RequestWithPrincipal } from "../authorization/authorization.guard";
import { RequireCapability } from "../authorization/require-capability.decorator";
import { requirePrincipal } from "./feed.controller";
import { GROUP_NAME_MAX_LENGTH, GroupService } from "./group.service";

/**
 * Groups, over HTTP.
 *
 * Under the feed's own base path, beside its static segments and never beside
 * an identifier, so no route here depends on the order two classes were
 * declared in.
 *
 * The same capability as the feed itself. What a person may do here is decided
 * by whether they live here and by whether they are in the group, and both are
 * the service's questions rather than the guard's - exactly as which audiences
 * there are is.
 *
 * There is no route that lists groups, and there is not going to be one. A group
 * is invisible to anybody who is not in it: the audiences endpoint answers the
 * ones this person is in, and every route here refuses a group they are not in
 * exactly as it refuses one that does not exist.
 */

/**
 * A group's name.
 *
 * Trimmed, and refused when nothing is left. A group with a name of spaces is
 * one its members cannot tell from the next, and the name is the only thing a
 * group has to be known by.
 */
const createSchema = z.object({
  name: z
    .string()
    .max(GROUP_NAME_MAX_LENGTH)
    .transform((value) => value.trim())
    .refine((value) => value !== ""),
});

const addMemberSchema = z.object({
  personId: z.string().min(1).max(64),
});

/**
 * What the picker is searching for.
 *
 * Absent means the first page of whoever lives here. A search is a few letters
 * of a name, bounded like every other free text that reaches a query.
 */
const candidatesQuerySchema = z.object({
  search: z
    .string()
    .max(100)
    .optional()
    .transform((value) => {
      const trimmed = value?.trim() ?? "";
      return trimmed === "" ? null : trimmed;
    }),
});

@Controller("api/feed/groups")
@RequireCapability("chat:participate")
export class GroupController {
  constructor(private readonly groups: GroupService) {}

  @Post()
  @HttpCode(201)
  async create(
    @Body() body: unknown,
    @Req() request: RequestWithPrincipal,
  ): Promise<CreatedGroupView> {
    const input = createSchema.parse(body);
    return this.groups.create(requirePrincipal(request), input.name);
  }

  @Get(":audienceId/candidates")
  async candidates(
    @Param("audienceId") audienceId: string,
    @Query() query: unknown,
    @Req() request: RequestWithPrincipal,
  ): Promise<GroupCandidateView[]> {
    const { search } = candidatesQuerySchema.parse(query);
    return this.groups.candidates(
      audienceId,
      requirePrincipal(request),
      search,
    );
  }

  @Get(":audienceId/members")
  async members(
    @Param("audienceId") audienceId: string,
    @Req() request: RequestWithPrincipal,
  ): Promise<GroupMemberView[]> {
    return this.groups.membersFor(audienceId, requirePrincipal(request));
  }

  @Post(":audienceId/members")
  @HttpCode(200)
  async addMember(
    @Param("audienceId") audienceId: string,
    @Body() body: unknown,
    @Req() request: RequestWithPrincipal,
  ): Promise<GroupMemberView[]> {
    const input = addMemberSchema.parse(body);
    return this.groups.addMember(
      requirePrincipal(request),
      audienceId,
      input.personId,
    );
  }

  /**
   * Leaving a room.
   *
   * No path segment naming who is leaving, because there is only ever one answer
   * and a route that took a person would be a route somebody would one day point
   * at a neighbour. Nobody takes anybody else out of a group.
   */
  @Delete(":audienceId/members/me")
  @HttpCode(204)
  async leave(
    @Param("audienceId") audienceId: string,
    @Req() request: RequestWithPrincipal,
  ): Promise<void> {
    await this.groups.leave(requirePrincipal(request), audienceId);
  }
}

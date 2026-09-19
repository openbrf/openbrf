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
import { z } from "zod";

import type { RequestWithPrincipal } from "../authorization/authorization.guard";
import { RequireCapability } from "../authorization/require-capability.decorator";
import {
  ChatGroupService,
  GROUP_NAME_MAX_LENGTH,
  type ChatGroupCandidateView,
  type ChatGroupMemberView,
} from "./chat-group.service";
import { requirePrincipal } from "./chat.controller";

/**
 * Groups, over HTTP.
 *
 * Its own base path rather than routes under `api/chat`, because that
 * controller's reading routes take a chat identifier as a path segment and a
 * static segment beside one is a route that depends on the order two classes
 * were declared in.
 *
 * The same capability as the rooms themselves. What a person may do here is
 * decided by whether they live here and by whether they are in the room, and
 * both are the service's questions rather than the guard's - exactly as which
 * rooms exist is.
 *
 * There is no route that lists groups, and there is not going to be one. A group
 * is invisible to anybody who is not in it: the rooms endpoint answers the ones
 * this person is in, and every route here refuses a room they are not in exactly
 * as it refuses one that does not exist.
 */

/**
 * A group's name.
 *
 * Trimmed, and refused when nothing is left. A room with a name of spaces is a
 * room its members cannot tell from the next one, and the name is the only thing
 * a group has to be known by.
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

@Controller("api/chat-groups")
@RequireCapability("chat:participate")
export class ChatGroupController {
  constructor(private readonly groups: ChatGroupService) {}

  @Post()
  @HttpCode(201)
  async create(
    @Body() body: unknown,
    @Req() request: RequestWithPrincipal,
  ): Promise<{ chatId: string; name: string }> {
    const input = createSchema.parse(body);
    return this.groups.create(requirePrincipal(request), input.name);
  }

  @Get(":chatId/candidates")
  async candidates(
    @Param("chatId") chatId: string,
    @Query() query: unknown,
    @Req() request: RequestWithPrincipal,
  ): Promise<ChatGroupCandidateView[]> {
    const { search } = candidatesQuerySchema.parse(query);
    return this.groups.candidates(chatId, requirePrincipal(request), search);
  }

  @Get(":chatId/members")
  async members(
    @Param("chatId") chatId: string,
    @Req() request: RequestWithPrincipal,
  ): Promise<ChatGroupMemberView[]> {
    return this.groups.membersFor(chatId, requirePrincipal(request));
  }

  @Post(":chatId/members")
  @HttpCode(200)
  async addMember(
    @Param("chatId") chatId: string,
    @Body() body: unknown,
    @Req() request: RequestWithPrincipal,
  ): Promise<ChatGroupMemberView[]> {
    const input = addMemberSchema.parse(body);
    return this.groups.addMember(
      requirePrincipal(request),
      chatId,
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
  @Delete(":chatId/members/me")
  @HttpCode(204)
  async leave(
    @Param("chatId") chatId: string,
    @Req() request: RequestWithPrincipal,
  ): Promise<void> {
    await this.groups.leave(requirePrincipal(request), chatId);
  }
}

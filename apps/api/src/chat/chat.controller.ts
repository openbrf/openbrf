import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  Req,
} from "@nestjs/common";
import { z } from "zod";

import type { RequestWithPrincipal } from "../authorization/authorization.guard";
import type { Principal } from "../authorization/capabilities";
import { RequireCapability } from "../authorization/require-capability.decorator";
import {
  CHAT_MESSAGE_MAX_LENGTH,
  type ChatMessageView,
  type ChatPage,
  type ChatRoomListView,
  ChatService,
  type ChatUpdate,
  parseChatCursor,
} from "./chat.service";

/**
 * The chat, over HTTP.
 *
 * Reading a room and writing into one, for somebody who is in it. Making a
 * group and who is in it are `chat-group.controller.ts`, and what the board does
 * with a message reported out of a room is `chat-report.controller.ts` - three
 * base paths rather than one, because a static segment beside a chat identifier
 * would be a route that depends on the order two classes were declared in.
 *
 * Every route is authenticated and there is no @Public() route in this file and
 * will not be one. Nothing about a chat is published: the association's website
 * reads no session at all, so a room there would be either anonymous or a login
 * wall on pages that promise neither.
 *
 * No route carries a @PublicRateLimit. That is deliberate rather than an
 * omission - the budget decorator exists for endpoints a stranger can reach, and
 * what bounds writing here is the per-person window counted from the rows
 * themselves.
 */

const bodySchema = z.object({
  /*
   * Trimmed, and refused when nothing is left. A message of spaces is not a
   * message, and storing one would put an empty line in a room nothing can
   * remove it from.
   */
  body: z
    .string()
    .max(CHAT_MESSAGE_MAX_LENGTH)
    .transform((value) => value.trim())
    .refine((value) => value !== ""),
});

/**
 * How far the reader has read.
 *
 * An instant the screen supplies rather than the moment of the request, because
 * what it marks is the newest message actually on screen. A marker set to "now"
 * by the server would mark a message read that was written while the request was
 * in flight and that the reader has never seen.
 *
 * Refused when it is not an instant, on the cursor's own reasoning: a value the
 * screen could not have produced is answered rather than repaired.
 */
const readSchema = z.object({
  readAt: z.string().transform((value, ctx) => {
    const instant = new Date(value);
    if (Number.isNaN(instant.getTime()) || instant.toISOString() !== value) {
      ctx.addIssue({ code: "custom", message: "is not an ISO instant" });
      return z.NEVER;
    }
    return instant;
  }),
});

/**
 * Which page of a room to answer with.
 *
 * Absent means the newest page, which is what a screen opening a room asks for.
 * Anything else has to be a cursor this application handed out, and one that is
 * not is refused here rather than read leniently further in: answering the
 * newest page to somebody who asked for an older one would tell a reader the
 * room ends where it does not.
 */
const pageQuerySchema = z.object({
  before: z
    .string()
    .optional()
    .transform((value, ctx) => {
      if (value === undefined) {
        return null;
      }
      const cursor = parseChatCursor(value);
      if (cursor === null) {
        ctx.addIssue({
          code: "custom",
          message: "is not a cursor into a chat",
        });
        return z.NEVER;
      }
      return cursor;
    }),
});

/**
 * Where the poll is asking from.
 *
 * Required, unlike `before`. A poll with no cursor is not a poll: it would be
 * asking for the whole room, which is what the page read is for, and a screen
 * that had lost its place would silently start requesting everything every four
 * seconds.
 */
const sinceQuerySchema = z.object({
  after: z.string().transform((value, ctx) => {
    const cursor = parseChatCursor(value);
    if (cursor === null) {
      ctx.addIssue({ code: "custom", message: "is not a cursor into a chat" });
      return z.NEVER;
    }
    return cursor;
  }),
});

/**
 * The acting person, or a fault.
 *
 * The global guard attaches a principal to every non-public route or rejects it,
 * so reaching this throw means the guard stopped doing that, and a 500 naming
 * the guard is the honest answer.
 *
 * Shared with the two controllers beside this one rather than spelled again in
 * each: the three are one feature's routes, and a second spelling is a second
 * chance to default an actor to nobody.
 */
export function requirePrincipal(request: RequestWithPrincipal): Principal {
  const principal = request.principal;
  if (principal === undefined) {
    throw new Error("The authorization guard did not attach a principal.");
  }
  return principal;
}

/** Reading the rooms somebody is in, and writing into one. */
@Controller("api/chat")
@RequireCapability("chat:participate")
export class ChatController {
  constructor(private readonly chat: ChatService) {}

  /**
   * The rooms this person is in, and whether they may make one.
   *
   * Empty rather than a refusal for somebody holding the capability and no room,
   * which is the administrator's case. They are in no room and may make none,
   * and that is an answer the screen can put into words - a refusal would be the
   * instance telling its own administrator that a page it offered them is
   * broken. A resident with no group is the other empty case and a different
   * sentence, which is why the two travel together.
   */
  @Get()
  async rooms(@Req() request: RequestWithPrincipal): Promise<ChatRoomListView> {
    return this.chat.rooms(requirePrincipal(request));
  }

  @Get(":chatId/since")
  async since(
    @Param("chatId") chatId: string,
    @Query() query: unknown,
    @Req() request: RequestWithPrincipal,
  ): Promise<ChatUpdate> {
    const { after } = sinceQuerySchema.parse(query);
    return this.chat.messagesSince(chatId, requirePrincipal(request), after);
  }

  /*
   * After the poll route, because a parameter segment would otherwise claim
   * "since" as a chat identifier - Fastify matches a static segment first, but
   * the two are declared in one class and the order they are read in is the
   * order they are written in.
   */
  @Get(":chatId")
  async read(
    @Param("chatId") chatId: string,
    @Query() query: unknown,
    @Req() request: RequestWithPrincipal,
  ): Promise<ChatPage> {
    const { before } = pageQuerySchema.parse(query);
    return this.chat.readChat(chatId, requirePrincipal(request), before);
  }

  @Post(":chatId/read")
  @HttpCode(200)
  async markRead(
    @Param("chatId") chatId: string,
    @Body() body: unknown,
    @Req() request: RequestWithPrincipal,
  ): Promise<{ readAt: string }> {
    const input = readSchema.parse(body);
    return this.chat.markRead(chatId, requirePrincipal(request), input.readAt);
  }

  @Post(":chatId")
  @HttpCode(201)
  async write(
    @Param("chatId") chatId: string,
    @Body() body: unknown,
    @Req() request: RequestWithPrincipal,
  ): Promise<ChatMessageView> {
    const input = bodySchema.parse(body);
    return this.chat.write({
      chatId,
      authorPersonId: requirePrincipal(request).personId,
      body: input.body,
    });
  }
}

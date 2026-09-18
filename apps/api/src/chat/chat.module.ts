import { Module } from "@nestjs/common";

import { ChatPurgeService } from "./chat-purge.service";
import { ChatController } from "./chat.controller";
import { ChatService } from "./chat.service";

/**
 * The chat: the rooms somebody is in, what is said in them, and the clock that
 * empties them.
 *
 * It imports nothing and exports nothing, which is worth stating rather than
 * leaving to be read off the decorator. The database client, the audit log and
 * the queue are global modules, so the three lines a feature usually needs are
 * already there; and nothing else in the product has any business reaching a
 * room. In particular nothing under `src/site` may import this module or select
 * these tables - the association's website reads no session at all, so there is
 * nobody for a room to be rendered to, and the module graph is what makes that a
 * property of the code rather than a rule somebody has to remember.
 *
 * No actions registrar either, and that is a decision rather than an omission.
 * Nothing here is a thing a connected app should be able to do: a token acting
 * as a person writing into the board's private deliberation is a surface with no
 * asked-for use, and a read of it would hand a program outside the instance the
 * one conversation the association holds that is not addressed to anybody.
 */
@Module({
  controllers: [ChatController],
  providers: [ChatService, ChatPurgeService],
})
export class ChatModule {}

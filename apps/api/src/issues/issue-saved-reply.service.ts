import { Injectable, Logger } from "@nestjs/common";
import { ISSUE_CONVERSATION_LIMITS } from "@openbrf/shared";
import type { TFunction } from "i18next";

import { PrismaService } from "../database/prisma.service";
import { refusePersonalIdentityNumbers } from "./issue-conversation.service";
import { lockIssueSavedReplies } from "./issue-lock";
import { IssueError } from "./issue.error";

/** A saved reply, as a handler picks it and the board edits it. */
export interface IssueSavedReplyView {
  id: string;
  title: string;
  body: string;
  sortOrder: number;
}

/** What the board writes for a saved reply. */
export interface IssueSavedReplyInput {
  title: string;
  body: string;
  sortOrder?: number;
}

/**
 * The saved replies a new instance starts with (decision 17), by their keys
 * under `issues.seededSavedReplies` in the language the setup wizard was
 * finished in. The second is the one the decision names: what was reported is
 * the tenant-owner's to maintain under the bylaws. Both are templates the board
 * rewords, and the second says what the association's bylaws say rather than
 * what the law says, because BRL 7 kap. 12 § lets each association's bylaws
 * draw that line differently.
 *
 * An instance whose setup finished before saved replies existed got the same
 * two from the migration that introduced them.
 */
const SEEDED_SAVED_REPLIES = ["received", "bylaws"] as const;

/**
 * The association's saved replies (decision 17): texts a handler starts an
 * issue message from.
 *
 * Written by `issues:configure` and read by everybody holding `issues:handle`,
 * the property manager included. Picking one sends nothing: the screen fills
 * the message field with it, and the handler sends what they choose, signed as
 * every message is. So a saved reply is the board's own text, scanned for
 * personal identity numbers as every text the board writes back to a resident
 * is, and never a name: the signature is the message's, decided when it is
 * sent.
 */
@Injectable()
export class IssueSavedReplyService {
  private readonly logger = new Logger(IssueSavedReplyService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Every saved reply, in the board's order. */
  async list(): Promise<IssueSavedReplyView[]> {
    return this.prisma.issueSavedReply.findMany({
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }, { id: "asc" }],
      select: SAVED_REPLY_SELECT,
    });
  }

  async create(input: IssueSavedReplyInput): Promise<IssueSavedReplyView> {
    refusePersonalIdentityNumbers({ title: input.title, body: input.body });
    const created = await this.prisma.$transaction(async (tx) => {
      await lockIssueSavedReplies(tx);
      const count = await tx.issueSavedReply.count();
      if (count >= ISSUE_CONVERSATION_LIMITS.savedReplies) {
        throw new IssueError(
          "The association already keeps as many saved replies as it may.",
          "too-many-saved-replies",
        );
      }
      return tx.issueSavedReply.create({
        data: {
          title: input.title,
          body: input.body,
          sortOrder: input.sortOrder ?? count,
        },
        select: SAVED_REPLY_SELECT,
      });
    });
    this.logger.log(`Saved reply ${created.id} added`);
    return created;
  }

  async update(
    id: string,
    input: IssueSavedReplyInput,
  ): Promise<IssueSavedReplyView> {
    refusePersonalIdentityNumbers({ title: input.title, body: input.body });
    /*
     * The write and the read in one transaction: the row lock the update takes
     * makes a removal arriving between them wait, so the read finds the row it
     * just wrote rather than failing with a missing-row error that would
     * answer 500 where this documents 404.
     */
    const updated = await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.issueSavedReply.updateMany({
        where: { id },
        data: {
          title: input.title,
          body: input.body,
          ...(input.sortOrder === undefined
            ? {}
            : { sortOrder: input.sortOrder }),
        },
      });
      if (count === 0) {
        throw notFound();
      }
      return tx.issueSavedReply.findUniqueOrThrow({
        where: { id },
        select: SAVED_REPLY_SELECT,
      });
    });
    this.logger.log(`Saved reply ${id} changed`);
    return updated;
  }

  /**
   * Removes a saved reply. Nothing refers to one: a message written from it is
   * the handler's own text, and keeps it.
   */
  async remove(id: string): Promise<void> {
    const { count } = await this.prisma.issueSavedReply.deleteMany({
      where: { id },
    });
    if (count === 0) {
      throw notFound();
    }
    this.logger.log(`Saved reply ${id} removed`);
  }

  /**
   * Writes the saved replies a new instance starts with, unless it has any.
   *
   * Called when the setup wizard finishes, beside the starting issue types and
   * for their reason. Writes nothing on a second run, so re-running the wizard
   * cannot bring back a reply the board removed.
   */
  async seedDefaults(t: TFunction): Promise<{ created: number }> {
    return this.prisma.$transaction(async (tx) => {
      await lockIssueSavedReplies(tx);
      if ((await tx.issueSavedReply.count()) > 0) {
        return { created: 0 };
      }
      for (const [sortOrder, key] of SEEDED_SAVED_REPLIES.entries()) {
        await tx.issueSavedReply.create({
          data: {
            title: t(`issues.seededSavedReplies.${key}.title`),
            body: t(`issues.seededSavedReplies.${key}.body`),
            sortOrder,
          },
        });
      }
      this.logger.log(
        `Wrote the ${SEEDED_SAVED_REPLIES.length} starting saved replies`,
      );
      return { created: SEEDED_SAVED_REPLIES.length };
    });
  }
}

const SAVED_REPLY_SELECT = {
  id: true,
  title: true,
  body: true,
  sortOrder: true,
} as const;

function notFound(): IssueError {
  return new IssueError("No such saved reply.", "saved-reply-not-found");
}

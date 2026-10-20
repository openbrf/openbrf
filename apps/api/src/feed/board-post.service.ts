import { Injectable, Logger } from "@nestjs/common";
import { BOARD_POST_AUDIENCES, type PostView } from "@openbrf/shared";

import type { ActorContext } from "../audit/actor-context";
import type { Principal } from "../authorization/capabilities";
import { PrismaService } from "../database/prisma.service";
import { NewsScheduleService } from "../news/news-schedule.service";
import { NewsWriteService } from "../news/news-write.service";
import { audienceFor, postFor, type FeedDbClient } from "./feed-audience";
import { speaksForBoard } from "./feed-board";
import { MAX_IMAGES_PER_POST } from "./feed-image";
import { lockFeedPerson, lockPost } from "./feed-lock";
import { FeedError, refusePersonalIdentityNumbers } from "./feed.error";
import {
  FeedService,
  refuseImagesNotAttachable,
  stampAfterNewest,
  WRITE_WINDOW_MINUTES,
} from "./feed.service";

/**
 * The longest title a post written as Styrelsen may carry: the news item's own
 * cap, because the title is the news item's.
 */
export const BOARD_POST_TITLE_MAX_LENGTH = 200;

/**
 * How many posts one board member may write as Styrelsen in
 * {@link WRITE_WINDOW_MINUTES}, counted over every news item they wrote.
 *
 * Far fewer than a resident's posts, because each one is a news item and may be
 * a mailing to every member: ten in ten minutes is more than any board
 * announcing anything needs, and a bound on how many mailings one account can
 * set off in an afternoon.
 */
export const BOARD_POSTS_PER_WRITE_WINDOW = 10;

/**
 * How far ahead a post may be scheduled. A year: a notice about next spring's
 * cleaning day can be written in the autumn, and an instant past that is more
 * likely a mistyped year than a plan.
 */
export const SCHEDULE_HORIZON_DAYS = 365;

/** A post the board writes as Styrelsen. */
export interface WriteBoardPostInput {
  /** Who it is for: Alla, Styrelsen or Administratörer. */
  audienceId: string;
  /** The news item's title, which the card, the website and a mailing show. */
  title: string;
  /** The text. A blank line starts a new paragraph of the news item. */
  body: string;
  /** Images uploaded for it, as a resident's post carries them. */
  imageIds?: readonly string[];
  /** Whether it reads "Styrelsen via" its writer, or only "Styrelsen". */
  namesAuthor: boolean;
  /**
   * Viktigt meddelande: must-read, and the news mailing - to the members for a
   * post to Alla, and to the audience's own members for any other.
   */
  important: boolean;
  /** Fäst överst. */
  pinned: boolean;
  /** Tillåt kommentarer. */
  commentsAllowed: boolean;
  /** Schemalägg publicering: the instant it appears, or null for now. */
  scheduledAt: Date | null;
  /**
   * Whether the news item is published to the street as well as the house.
   * Only a post to Alla is on the website at all.
   */
  onWebsite: boolean;
}

/**
 * The board's tools in the feed: writing as Styrelsen, and pinning what it
 * wrote (ADR 0026).
 *
 * Three rules live here and nowhere else.
 *
 * **Only the board speaks as the board.** Every act here asks `speaksForBoard`
 * first - a board seat that has not ended, and the capability that publishes in
 * the association's name - and refuses anybody else with `not-board`, whatever a
 * screen offered them. The screen's options are a convenience; this is the rule.
 *
 * **A post written as Styrelsen is a news item, read by its audience alone.**
 * It is written as an item and published through the news module's own path
 * in the same transaction, so "Viktigt meddelande" claims the news mailing
 * exactly once and the audit log records the item's creation and publication
 * as it records any other. It goes to Alla, Styrelsen or Administratörer. To
 * Alla, the item is what the association says to the house: the website shows
 * it to the members, or to the street when the board asks, and the mailing goes
 * to the members. To Styrelsen or Administratörer, the item is confined to its
 * post's audience (`news-audience.ts`): on no website and no news screen, and
 * mailed only to that audience. A group is not the board's to speak in at all
 * (ADR 0012).
 *
 * **A scheduled post waits as a draft.** Its news item is written unpublished,
 * its post carries the instant, and a job due at that instant publishes it -
 * mailing and all - as if the board had pressed publish then. Until it does, it
 * is in no feed but the board's, on no website and in no mailbox.
 *
 * What the post itself carries is the writer's choice and the board's flags;
 * what it says is the item's. Editing it afterwards is the news screen's, for
 * now, and the edit history the feed records arrives with editing itself.
 */
@Injectable()
export class BoardPostService {
  private readonly logger = new Logger(BoardPostService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly feed: FeedService,
    private readonly news: NewsWriteService,
    private readonly schedule: NewsScheduleService,
  ) {}

  /**
   * Writes a post as Styrelsen.
   *
   * The refusals in order: somebody who is not the board, an audience they are
   * not in, a group, the website asked for outside Alla, too many images, an
   * instant that is not ahead within the horizon, too many posts, and text
   * carrying a personal identity number. The board check is first because
   * nothing after it means anything to somebody it refuses.
   */
  async write(
    reader: Principal,
    input: WriteBoardPostInput,
    actor: ActorContext,
  ): Promise<PostView> {
    const now = new Date();
    await this.requireBoard(reader, now);

    const audience = await audienceFor(
      this.prisma,
      input.audienceId,
      reader.personId,
      now,
    );
    if (audience === null) {
      throw new FeedError("There is no such audience.", "audience-not-found");
    }
    if (!BOARD_POST_AUDIENCES.includes(audience.kind)) {
      throw new FeedError(
        "A post written as Styrelsen goes to Alla, Styrelsen or Administratörer.",
        "board-post-audience",
      );
    }
    if (input.onWebsite && audience.kind !== "ALL") {
      // The website is the street's, and the street is not in Styrelsen.
      throw new FeedError(
        "Only a post to Alla is on the website.",
        "board-post-audience",
      );
    }
    const imageIds = input.imageIds ?? [];
    if (imageIds.length > MAX_IMAGES_PER_POST) {
      throw new FeedError(
        "A post carries no more images than the feed allows.",
        "too-many-images",
      );
    }
    refuseOutOfRange(input.scheduledAt, now);
    await refuseTooManyBoardPosts(this.prisma, reader.personId);
    refusePersonalIdentityNumbers(input.title, "title");
    refusePersonalIdentityNumbers(input.body);

    const scheduledAt = input.scheduledAt;
    const visibility = input.onWebsite ? "PUBLIC" : "MEMBER";
    /*
     * Outside the transaction, because creating a queue is the queue backend's
     * own work on its own connection. A scheduled post's mailing is claimed by
     * the job, which creates the mailing's queue then.
     */
    if (scheduledAt === null) {
      await this.news.prepareToPublish({ sendEmail: input.important });
    } else {
      await this.schedule.ensureQueue();
    }

    const { postId, mailedTo } = await this.prisma.$transaction(async (tx) => {
      // Counted again under the writer's own lock, which is what makes the
      // allowance a bound: parallel requests can all pass the count above.
      await lockFeedPerson(tx, reader.personId);
      await refuseTooManyBoardPosts(tx, reader.personId);
      await refuseImagesNotAttachable(tx, reader.personId, imageIds, now);

      const item = await this.news.writeForFeed(
        tx,
        {
          title: input.title,
          text: input.body,
          visibility,
          authorPersonId: reader.personId,
          confined: audience.kind !== "ALL",
        },
        actor,
      );

      const post = await tx.post.create({
        data: {
          audienceId: audience.id,
          authorPersonId: reader.personId,
          byBoard: true,
          namesAuthor: input.namesAuthor,
          body: null,
          newsId: item.id,
          important: input.important,
          pinnedAt: input.pinned ? now : null,
          commentsAllowed: input.commentsAllowed,
          scheduledAt,
          /*
           * A scheduled post's place is its instant, which the first
           * publication moves to the feed's own order if the job runs late
           * (`putNewsItemInFeed`). One written now is stamped now.
           */
          createdAt: scheduledAt ?? (await stampAfterNewest(tx)),
        },
        select: { id: true },
      });
      if (imageIds.length > 0) {
        await tx.postImage.createMany({
          data: imageIds.map((fileId, sortOrder) => ({
            postId: post.id,
            fileId,
            sortOrder,
          })),
        });
      }

      if (scheduledAt !== null) {
        await this.schedule.scheduleInTransaction(tx, scheduledAt, {
          newsId: item.id,
          personId: reader.personId,
          sendEmail: input.important,
        });
        return { postId: post.id, mailedTo: null };
      }
      return {
        postId: post.id,
        mailedTo: await this.news.publishForFeed(
          tx,
          item.id,
          { visibility, sendEmail: input.important },
          actor,
          now,
        ),
      };
    });

    this.logger.log(
      scheduledAt === null
        ? `A post was written as Styrelsen: post ${postId}${
            mailedTo === null ? "" : `, mailed to ${String(mailedTo)} members`
          }`
        : `A post was scheduled as Styrelsen: post ${postId}`,
    );

    return this.feed.viewOf(reader, postId, new Date());
  }

  /**
   * Pins a post written as Styrelsen to the top of the feed, or takes the pin
   * off.
   *
   * Only the board's own posts: a pin is the board saying "this first", and a
   * neighbour's words pinned above everybody else's by the board would be the
   * board speaking with somebody else's voice. Refused as a post that does not
   * exist when the reader may not read it, as every path here refuses.
   * Idempotent: pinning a pinned post keeps the instant it was first pinned.
   */
  async pin(
    reader: Principal,
    postId: string,
    pinned: boolean,
  ): Promise<PostView> {
    const now = new Date();
    await this.requireBoard(reader, now);
    const post = await postFor(this.prisma, postId, reader.personId, now);
    if (post === null) {
      throw new FeedError("There is no such post.", "post-not-found");
    }

    await this.prisma.$transaction(async (tx) => {
      await lockPost(tx, post.id);
      const row = await tx.post.findUnique({
        where: { id: post.id },
        select: { byBoard: true, pinnedAt: true },
      });
      if (row === null) {
        throw new FeedError("There is no such post.", "post-not-found");
      }
      if (!row.byBoard) {
        throw new FeedError(
          "Only a post written as Styrelsen can be pinned.",
          "not-pinnable",
        );
      }
      if (pinned === (row.pinnedAt !== null)) {
        return;
      }
      await tx.post.update({
        where: { id: post.id },
        data: { pinnedAt: pinned ? now : null },
      });
    });

    return this.feed.viewOf(reader, post.id, new Date());
  }

  /** Refuses somebody who may not speak as Styrelsen. */
  private async requireBoard(reader: Principal, now: Date): Promise<void> {
    if (!(await speaksForBoard(this.prisma, reader, now))) {
      throw new FeedError(
        "Only somebody holding a board seat writes as Styrelsen.",
        "not-board",
      );
    }
  }
}

/** Refuses an instant that has passed, or that is further off than allowed. */
function refuseOutOfRange(scheduledAt: Date | null, now: Date): void {
  if (scheduledAt === null) {
    return;
  }
  const horizon = now.getTime() + SCHEDULE_HORIZON_DAYS * 24 * 60 * 60 * 1000;
  if (
    scheduledAt.getTime() <= now.getTime() ||
    scheduledAt.getTime() > horizon
  ) {
    throw new FeedError(
      "A post is scheduled for an instant ahead, within a year.",
      "schedule-out-of-range",
    );
  }
}

/**
 * Refuses a board member who has written their allowance of posts as
 * Styrelsen for the window, counted over the news items they wrote - on the
 * news screen as well, because every one of them may be a mailing.
 */
async function refuseTooManyBoardPosts(
  db: FeedDbClient,
  authorPersonId: string,
): Promise<void> {
  const since = new Date(Date.now() - WRITE_WINDOW_MINUTES * 60 * 1000);
  const written = await db.news.count({
    where: { authorPersonId, createdAt: { gte: since } },
  });
  if (written >= BOARD_POSTS_PER_WRITE_WINDOW) {
    throw new FeedError(
      "Too many posts in too short a time. Try again shortly.",
      "too-many-posts",
    );
  }
}

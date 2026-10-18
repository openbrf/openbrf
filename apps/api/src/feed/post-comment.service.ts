import { Injectable, Logger } from "@nestjs/common";
import type {
  LikeView,
  PostCommentPage,
  PostCommentView,
} from "@openbrf/shared";

import type { Principal } from "../authorization/capabilities";
import { PrismaService } from "../database/prisma.service";
import type { Prisma } from "../generated/prisma/client";
import { holdsBoardSeat } from "../mail/board-recipients";
import {
  type FeedDbClient,
  postFor,
  type ReachablePost,
} from "./feed-audience";
import { readAuthors } from "./feed-author";
import { type FeedCursor, feedCursor, olderThan } from "./feed-cursor";
import { lockFeedPerson } from "./feed-lock";
import { FeedError, refusePersonalIdentityNumbers } from "./feed.error";

/**
 * The longest comment this application stores. The cap a post carries, for the
 * same reason, and the cap a news comment always carried.
 */
export const COMMENT_MAX_LENGTH = 2000;

/**
 * How many comments one person may write in {@link COMMENT_WINDOW_MINUTES}.
 *
 * The news thread's number, because a comment under a news item is a comment
 * under its post and one person has one budget for both. Twenty in ten minutes
 * is one every thirty seconds sustained, far above what anybody typing writes
 * and far below what a script would want.
 *
 * Counted from the rows and again under the writer's own lock, so requests in
 * flight together cannot all pass it.
 */
export const COMMENTS_PER_WRITE_WINDOW = 20;

/** The window {@link COMMENTS_PER_WRITE_WINDOW} is counted over. */
export const COMMENT_WINDOW_MINUTES = 10;

/**
 * How many comments one read of a post answers with: a bound, with a cursor to
 * the page before, for the reason a news thread is paged.
 */
export const COMMENTS_PER_PAGE = 50;

/** The columns a comment is read with to be shown, for one reader. */
function commentColumns(readerId: string) {
  return {
    id: true,
    postId: true,
    authorPersonId: true,
    byBoard: true,
    body: true,
    createdAt: true,
    editedAt: true,
    struckAt: true,
    _count: { select: { likes: true } },
    likes: { where: { personId: readerId }, select: { personId: true } },
  } satisfies Prisma.PostCommentSelect;
}

type CommentRow = Prisma.PostCommentGetPayload<{
  select: ReturnType<typeof commentColumns>;
}>;

/**
 * Comments under posts (kommentarer): flat, oldest first, and as visible as the
 * post they sit on.
 *
 * **Visibility is the post's, never the comment's own.** There is no audience on
 * a comment: whoever may read the post may read its comments and write one, and
 * nobody else learns that either exists. Every path asks `postFor`, the feed's
 * one check, before it touches a comment.
 *
 * **A comment is a record.** Nothing deletes one but the retention clock, which
 * reaches it a year after it was written or with its post. The board strikes
 * through and the text is then withheld from everybody but its author and the
 * board.
 *
 * **A post can close its thread.** A post the board wrote with comments turned
 * off takes none, and a struck post takes none: what the board withheld is not a
 * thing to answer in front of the others.
 *
 * **A personal identity number is refused**, and **a comment write is not
 * audited**, for the reasons `feed.service.ts` gives about a post. The news
 * screen's thread writes its own entry still, and keeps doing so until the feed
 * replaces that screen (ADR 0026).
 */
@Injectable()
export class PostCommentService {
  private readonly logger = new Logger(PostCommentService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * One page of a post's comments, oldest first within the page.
   *
   * The newest page when nobody asks for one, turned round inside itself: a
   * reader opening a long thread lands where the conversation is, and their own
   * comment is on the page the moment they write it.
   */
  async page(
    reader: Principal,
    postId: string,
    before: FeedCursor | null = null,
  ): Promise<PostCommentPage> {
    const now = new Date();
    const post = await this.requirePost(reader, postId, now);

    const rows = await this.prisma.postComment.findMany({
      where: {
        AND: [
          { postId: post.id },
          ...(before === null ? [] : [olderThan(before)]),
        ],
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: COMMENTS_PER_PAGE + 1,
      select: commentColumns(reader.personId),
    });
    const page = rows.slice(0, COMMENTS_PER_PAGE);
    const oldest = page.at(-1);

    return {
      comments: await this.toViews([...page].reverse(), reader, now),
      earlier:
        oldest !== undefined && rows.length > page.length
          ? feedCursor(oldest)
          : null,
    };
  }

  /**
   * Writes a comment under a post.
   *
   * Refused in order: a post this person may not read, a post that takes no
   * comments, a person who has written too many, and text carrying a personal
   * identity number.
   */
  async write(
    reader: Principal,
    postId: string,
    body: string,
  ): Promise<PostCommentView> {
    const now = new Date();
    const post = await this.requirePost(reader, postId, now);
    if (!post.commentsAllowed || post.struckAt !== null) {
      throw new FeedError(
        "This post does not take comments.",
        "comments-closed",
      );
    }
    await refuseTooManyComments(this.prisma, reader.personId);
    refusePersonalIdentityNumbers(body);

    const row = await this.prisma.$transaction(async (tx) => {
      await lockFeedPerson(tx, reader.personId);
      await refuseTooManyComments(tx, reader.personId);
      return tx.postComment.create({
        data: { postId: post.id, authorPersonId: reader.personId, body },
        select: commentColumns(reader.personId),
      });
    });

    this.logger.log(`A comment was written on post ${post.id}`);

    const [view] = await this.toViews([row], reader, now);
    if (view === undefined) {
      throw new Error("A comment just written could not be shown.");
    }
    return view;
  }

  /**
   * Likes a comment, or takes the like back. Idempotent both ways, as a post's
   * like is, and only for somebody who may read the post it sits on.
   */
  async like(
    reader: Principal,
    commentId: string,
    liked: boolean,
  ): Promise<LikeView> {
    const comment = await this.prisma.postComment.findUnique({
      where: { id: commentId },
      select: { id: true, postId: true },
    });
    if (
      comment === null ||
      (await postFor(
        this.prisma,
        comment.postId,
        reader.personId,
        new Date(),
      )) === null
    ) {
      // A comment under a post this person may not read is answered exactly as
      // one that does not exist.
      throw new FeedError("There is no such comment.", "comment-not-found");
    }

    if (liked) {
      await this.prisma.$executeRaw`
        INSERT INTO "post_comment_like" ("commentId", "personId", "createdAt")
        VALUES (${comment.id}, ${reader.personId}, ${new Date()})
        ON CONFLICT ("commentId", "personId") DO NOTHING
      `;
    } else {
      await this.prisma.postCommentLike.deleteMany({
        where: { commentId: comment.id, personId: reader.personId },
      });
    }

    return {
      liked,
      likes: await this.prisma.postCommentLike.count({
        where: { commentId: comment.id },
      }),
    };
  }

  /** The post this person may read, or the one refusal. */
  private async requirePost(
    reader: Principal,
    postId: string,
    now: Date,
  ): Promise<ReachablePost> {
    const post = await postFor(this.prisma, postId, reader.personId, now);
    if (post === null) {
      throw new FeedError("There is no such post.", "post-not-found");
    }
    return post;
  }

  /** Every view in a page, with the authors resolved in one read. */
  private async toViews(
    rows: readonly CommentRow[],
    reader: Principal,
    now: Date,
  ): Promise<PostCommentView[]> {
    const attribute = await readAuthors(
      this.prisma,
      rows.map((row) => row.authorPersonId),
    );

    // The board opens a struck comment's text, and so does having written it -
    // asked of the register only when the page has one somebody else wrote.
    const moderates =
      rows.some(
        (row) =>
          row.struckAt !== null && row.authorPersonId !== reader.personId,
      ) &&
      reader.capabilities.has("chat:moderate") &&
      (await holdsBoardSeat(this.prisma, reader.personId, now));

    return rows.map((row) => ({
      id: row.id,
      postId: row.postId,
      author: attribute(row.authorPersonId),
      byBoard: row.byBoard,
      body:
        row.struckAt !== null &&
        !moderates &&
        row.authorPersonId !== reader.personId
          ? null
          : row.body,
      createdAt: row.createdAt.toISOString(),
      editedAt: row.editedAt?.toISOString() ?? null,
      struckAt: row.struckAt?.toISOString() ?? null,
      likes: row._count.likes,
      liked: row.likes.length > 0,
    }));
  }
}

/**
 * Refuses a person who has written their allowance of comments for the window.
 *
 * Exported because the news screen's thread writes into the same table and one
 * person has one budget, whichever screen they write from.
 */
export async function refuseTooManyComments(
  db: FeedDbClient,
  authorPersonId: string,
  refusal: () => Error = () =>
    new FeedError(
      "Too many comments in too short a time. Try again shortly.",
      "too-many-comments",
    ),
): Promise<void> {
  const since = new Date(Date.now() - COMMENT_WINDOW_MINUTES * 60 * 1000);
  const written = await db.postComment.count({
    where: { authorPersonId, createdAt: { gte: since } },
  });
  if (written >= COMMENTS_PER_WRITE_WINDOW) {
    throw refusal();
  }
}

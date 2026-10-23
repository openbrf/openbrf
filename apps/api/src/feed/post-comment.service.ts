import { Injectable, Logger } from "@nestjs/common";
import type {
  LikeView,
  PostCommentPage,
  PostCommentUpdate,
  PostCommentView,
  RevisionListView,
} from "@openbrf/shared";
import { BOARD_POST_AUDIENCES } from "@openbrf/shared";

import type { Principal } from "../authorization/capabilities";
import { PrismaService } from "../database/prisma.service";
import type { Prisma } from "../generated/prisma/client";
import {
  type FeedDbClient,
  postFor,
  type ReachablePost,
  refuseErasedPost,
  takesComments,
} from "./feed-audience";
import { readAuthors } from "./feed-author";
import { speaksForBoard } from "./feed-board";
import {
  type FeedCursor,
  feedCursor,
  newerThan,
  olderThan,
} from "./feed-cursor";
import { lockFeedPerson, lockPostThread } from "./feed-lock";
import { FeedError, refusePersonalIdentityNumbers } from "./feed.error";
import { refuseFullHistory, revisionView } from "./feed-revision";
import {
  answersReports,
  moderatedComment,
  moderationOf,
  strikesWithoutReport,
} from "./post-report-access";

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
 * the page before, for the reason a news thread is paged. A poll of the thread
 * is bounded by it too, and says when more was waiting.
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
    // This reader's own report: one person reports one comment once.
    reports: {
      where: { reporterPersonId: readerId },
      select: { id: true },
      take: 1,
    },
  } satisfies Prisma.PostCommentSelect;
}

type CommentRow = Prisma.PostCommentGetPayload<{
  select: ReturnType<typeof commentColumns>;
}>;

declare const reachedBrand: unique symbol;

/**
 * A comment somebody may read, and the post it is under that says so.
 *
 * Made by {@link reachedComment} from a {@link ReachablePost}, which only
 * `postFor` makes, and by nothing else: {@link PostCommentService.comment} shows
 * it without asking again, so a value built any other way would be a way to read
 * a comment under a post the reader is not in. The type does not say for which
 * reader the post was asked; every caller asks for the reader it then passes.
 */
export interface ReachedComment {
  readonly [reachedBrand]: true;
  id: string;
  authorPersonId: string;
  post: ReachablePost;
}

/**
 * The comment a reader reached through the {@link ReachablePost} it is under:
 * the one place a {@link ReachedComment} is made. Refuses a post the comment is
 * not under.
 */
export function reachedComment(
  comment: { id: string; postId: string; authorPersonId: string },
  post: ReachablePost,
): ReachedComment {
  if (comment.postId !== post.id) {
    throw new Error("A comment is reached through the post it is under.");
  }
  return {
    id: comment.id,
    authorPersonId: comment.authorPersonId,
    post,
  } as ReachedComment;
}

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
 * reaches it a year after it was written whatever became of its post, and its
 * writer's granted erasure request. The board strikes through and the text is
 * then withheld from everybody but its author and the board.
 *
 * **A post can close its thread.** A post the board wrote with comments turned
 * off takes none, and a struck post takes none: what the board withheld is not a
 * thing to answer in front of the others. An erased post takes none either: the
 * comments under it stand until their own dates, and nobody is answering the
 * post any more.
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
    const newest = page.at(0);

    return {
      comments: await this.toViews([...page].reverse(), reader, post, now),
      earlier:
        oldest !== undefined && rows.length > page.length
          ? feedCursor(oldest)
          : null,
      latest: newest === undefined ? null : feedCursor(newest),
    };
  }

  /**
   * The comments written under a post since a cursor, oldest first: the poll
   * of an open thread (ADR 0010), and the read after a reader writes one.
   *
   * Forwards from where the reader's thread ends rather than the newest page
   * again, so a thread that fifty neighbours answered while it was open is
   * delivered whole, a page at a time, instead of as its newest fifty with a
   * gap behind them that no cursor reaches. Refused on exactly the terms a page
   * is, and a struck comment's text withheld on the same rule.
   */
  async since(
    reader: Principal,
    postId: string,
    after: FeedCursor,
  ): Promise<PostCommentUpdate> {
    const now = new Date();
    const post = await this.requirePost(reader, postId, now);

    const rows = await this.prisma.postComment.findMany({
      where: { AND: [{ postId: post.id }, newerThan(after)] },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: COMMENTS_PER_PAGE + 1,
      select: commentColumns(reader.personId),
    });
    const page = rows.slice(0, COMMENTS_PER_PAGE);
    const newest = page.at(-1);

    return {
      comments: await this.toViews(page, reader, post, now),
      // The cursor handed in comes back when nothing arrived, so a thread
      // polled while nobody writes keeps its place.
      cursor: newest === undefined ? feedCursor(after) : feedCursor(newest),
      more: rows.length > page.length,
    };
  }

  /**
   * Writes a comment under a post.
   *
   * Refused in order: a post this person may not read, a post that has been
   * erased or takes no comments, a comment as Styrelsen from somebody who may
   * not speak for the board or under a post in a group, a person who has
   * written too many, and text carrying a personal identity number.
   *
   * ## As Styrelsen
   *
   * A board seat holder may answer as the board rather than as themselves - the
   * association answering a neighbour's question under its own notice. The
   * comment still names its writer ("Styrelsen via ..."): a comment is one
   * person's words on that person's clock, and its writer is who a report, an
   * erasure request or an access report has to find. In Alla, Styrelsen and
   * Administratörer, where a post written as Styrelsen may go, and never in a
   * group, which is not the board's to speak in (ADR 0012). Membership is
   * asked first, as it is for every comment: the post has to be one the writer
   * may read.
   */
  async write(
    reader: Principal,
    postId: string,
    body: string,
    options: { asBoard?: boolean } = {},
  ): Promise<PostCommentView> {
    const now = new Date();
    const post = await this.requirePost(reader, postId, now);
    refuseClosedThread(post);
    const asBoard = options.asBoard === true;
    if (asBoard) {
      if (!(await speaksForBoard(this.prisma, reader, now))) {
        throw new FeedError(
          "Only somebody holding a board seat writes as Styrelsen.",
          "not-board",
        );
      }
      if (!BOARD_POST_AUDIENCES.includes(post.audience.kind)) {
        throw new FeedError(
          "A comment written as Styrelsen goes under a post to Alla, Styrelsen or Administratörer.",
          "board-post-audience",
        );
      }
    }
    await refuseTooManyComments(this.prisma, reader.personId);
    refusePersonalIdentityNumbers(body);

    const row = await this.prisma.$transaction(async (tx) => {
      await lockFeedPerson(tx, reader.personId);
      await refuseTooManyComments(tx, reader.personId);
      // Read again under a share lock, so a comment never lands under a post
      // the purge erased while this request was on its way.
      refuseClosedThread(await refuseErasedPost(tx, post.id));
      return tx.postComment.create({
        data: {
          postId: post.id,
          authorPersonId: reader.personId,
          byBoard: asBoard,
          body,
          createdAt: await stampCommentAfterNewest(tx, post.id),
        },
        select: commentColumns(reader.personId),
      });
    });

    this.logger.log(`A comment was written on post ${post.id}`);

    const [view] = await this.toViews([row], reader, post, now);
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

  /**
   * Edits a comment its writer wrote, keeping what it said before.
   *
   * On the post's terms (`FeedService.edit`): the text that stood goes into the
   * comment's history, the comment says it was edited, and the writer and the
   * board read the history. A comment written as Styrelsen names its writer
   * and is theirs to edit, as it is theirs on every other count. Not one the
   * board struck, whose words were withheld because of what they said. Under a
   * post the purge has erased a comment still stands on its own clock, and is
   * still its writer's to correct.
   *
   * The row is read again under its own lock, so an edit waits for a strike or
   * the purge in flight and reads what it left.
   */
  async edit(
    reader: Principal,
    commentId: string,
    body: string,
  ): Promise<PostCommentView> {
    const now = new Date();
    const comment = await this.requireComment(reader, commentId, now);
    refusePersonalIdentityNumbers(body);

    await this.prisma.$transaction(async (tx) => {
      const [row] = await tx.$queryRaw<
        {
          authorPersonId: string;
          body: string;
          createdAt: Date;
          editedAt: Date | null;
          struckAt: Date | null;
        }[]
      >`SELECT "authorPersonId", "body", "createdAt", "editedAt", "struckAt" FROM "post_comment" WHERE "id" = ${comment.id} FOR UPDATE`;
      if (row === undefined) {
        throw new FeedError("There is no such comment.", "comment-not-found");
      }
      if (row.authorPersonId !== reader.personId || row.struckAt !== null) {
        throw new FeedError(
          "Only its writer edits a comment, and not one the board struck.",
          "not-editable",
        );
      }
      if (row.body === body) {
        return;
      }
      refuseFullHistory(
        await tx.postCommentRevision.count({
          where: { commentId: comment.id },
        }),
      );

      const edited = new Date();
      await tx.postCommentRevision.create({
        data: {
          commentId: comment.id,
          body: row.body,
          writtenAt: row.editedAt ?? row.createdAt,
          replacedAt: edited,
        },
      });
      await tx.postComment.update({
        where: { id: comment.id },
        data: { body, editedAt: edited },
      });
    });

    this.logger.log(`Comment ${comment.id} was edited`);

    return this.comment(reader, comment, now);
  }

  /**
   * One comment, as this reader is shown it: what an edit and the board's
   * strike answer with.
   *
   * Handed the comment the act has just reached rather than its identifier,
   * so it is not asked again whether this reader may read it: a
   * {@link ReachedComment} can only be made from a post `postFor` answered, which
   * the caller asked for this reader.
   */
  async comment(
    reader: Principal,
    comment: ReachedComment,
    now: Date,
  ): Promise<PostCommentView> {
    const row = await this.prisma.postComment.findUnique({
      where: { id: comment.id },
      select: commentColumns(reader.personId),
    });
    const [view] =
      row === null ? [] : await this.toViews([row], reader, comment.post, now);
    if (view === undefined) {
      throw new FeedError("There is no such comment.", "comment-not-found");
    }
    return view;
  }

  /**
   * A comment's earlier versions, the most recently replaced first: for its
   * writer and the board, on the post's terms (`FeedService.history`).
   */
  async history(
    reader: Principal,
    commentId: string,
  ): Promise<RevisionListView> {
    const now = new Date();
    const comment = await this.requireComment(reader, commentId, now);
    if (
      comment.authorPersonId !== reader.personId &&
      !(await answersReports(this.prisma, reader, now))
    ) {
      throw new FeedError(
        "The earlier versions of a comment are its writer's and the board's.",
        "history-withheld",
      );
    }

    const revisions = await this.prisma.postCommentRevision.findMany({
      where: { commentId: comment.id },
      orderBy: [{ replacedAt: "desc" }, { id: "desc" }],
      select: { body: true, writtenAt: true, replacedAt: true },
    });
    return { revisions: revisions.map(revisionView) };
  }

  /**
   * The comment this person may read - one under a post they may read - or the
   * one refusal, for a comment that does not exist and one under a post in an
   * audience they are not in alike.
   */
  private async requireComment(
    reader: Principal,
    commentId: string,
    now: Date,
  ): Promise<ReachedComment> {
    const comment = await this.prisma.postComment.findUnique({
      where: { id: commentId },
      select: { id: true, postId: true, authorPersonId: true },
    });
    const post =
      comment === null
        ? null
        : await postFor(this.prisma, comment.postId, reader.personId, now);
    if (comment === null || post === null) {
      throw new FeedError("There is no such comment.", "comment-not-found");
    }
    return reachedComment(comment, post);
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

  /**
   * Every view in a page, with the authors resolved in one read.
   *
   * Every row is under the one post handed in, whose audience decides whether
   * a comment can be reported to the board or struck through by it.
   */
  private async toViews(
    rows: readonly CommentRow[],
    reader: Principal,
    post: ReachablePost,
    now: Date,
  ): Promise<PostCommentView[]> {
    const attribute = await readAuthors(
      this.prisma,
      rows.map((row) => row.authorPersonId),
    );

    /*
     * The board opens a struck comment's text and an edited comment's earlier
     * versions, and so does having written it; and in Alla the board strikes
     * a comment through without a report. Asked of the register only when the
     * page has something that turns on it.
     */
    const kind = post.audience.kind;
    const moderates =
      rows.some(
        (row) =>
          ((row.struckAt !== null || row.editedAt !== null) &&
            row.authorPersonId !== reader.personId) ||
          (strikesWithoutReport(kind) && row.struckAt === null),
      ) && (await answersReports(this.prisma, reader, now));

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
      mayEdit: row.authorPersonId === reader.personId && row.struckAt === null,
      mayReadHistory:
        row.editedAt !== null &&
        (row.authorPersonId === reader.personId || moderates),
      ...moderationOf(moderatedComment(row, kind), {
        personId: reader.personId,
        moderates,
        reported: row.reports.length > 0,
      }),
    }));
  }
}

/**
 * Refuses a post the purge has erased, one that takes no comments, and one the
 * board struck: what the board withheld is not a thing to answer in front of
 * the others.
 */
function refuseClosedThread(post: {
  struckAt: Date | null;
  commentsAllowed: boolean;
  erasedAt?: Date | null;
}): void {
  if (post.erasedAt != null) {
    throw new FeedError("This post has been erased.", "post-erased");
  }
  if (!takesComments(post)) {
    throw new FeedError("This post does not take comments.", "comments-closed");
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

/**
 * The instant a comment is stamped with: now, or a millisecond after the newest
 * comment under its post if the clock has not moved past it.
 *
 * Under `lockPostThread`, so the order the instants say is the order the
 * comments under one post were committed in - see that lock for why a thread's
 * poll needs it. `stampAfterNewest` is the same rule for posts across the feed.
 *
 * Exported because the news screen's thread writes into the same table, under
 * the same posts, and is read by the same poll.
 */
export async function stampCommentAfterNewest(
  tx: Prisma.TransactionClient,
  postId: string,
): Promise<Date> {
  await lockPostThread(tx, postId);
  const newest = await tx.postComment.findFirst({
    where: { postId },
    orderBy: [{ createdAt: "desc" }],
    select: { createdAt: true },
  });
  const now = new Date();
  return newest !== null && newest.createdAt.getTime() >= now.getTime()
    ? new Date(newest.createdAt.getTime() + 1)
    : now;
}

import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
} from "@nestjs/common";
import type {
  AudienceListView,
  FeedPage,
  FeedUpdate,
  LikeView,
  NotReadView,
  PostCommentPage,
  PostCommentUpdate,
  PostCommentView,
  PostImageView,
  PostReadView,
  PostView,
  RevisionListView,
} from "@openbrf/shared";
import { z } from "zod";

import { webActor } from "../audit/actor-context";
import type { RequestWithPrincipal } from "../authorization/authorization.guard";
import type { Principal } from "../authorization/capabilities";
import { RequireCapability } from "../authorization/require-capability.decorator";
import { isTooLarge, readSingleFile } from "../http/multipart";
import { MediaError } from "../media/media.service";
import {
  BOARD_POST_TITLE_MAX_LENGTH,
  BoardPostService,
} from "./board-post.service";
import { parseFeedCursor } from "./feed-cursor";
import {
  FeedService,
  POST_MAX_LENGTH,
  SEARCH_MAX_LENGTH,
} from "./feed.service";
import { COMMENT_MAX_LENGTH, PostCommentService } from "./post-comment.service";

/**
 * The feed, over HTTP.
 *
 * Reading the feed and writing to it, for somebody in an audience, and the
 * board writing to it as Styrelsen. Making a group and who is in it are
 * `group.controller.ts`, and what the board does with a post reported out of a
 * group is `post-report.controller.ts`.
 *
 * Every route is authenticated and there is no @Public() route in this file and
 * will not be one. Nothing here is rendered on the association's website, which
 * reads no session at all: a board post reaches the street as the news item it
 * is, through the news module's own pages.
 *
 * No route carries a @PublicRateLimit. That is deliberate rather than an
 * omission - the budget decorator exists for endpoints a stranger can reach, and
 * what bounds writing here is the per-person window counted from the rows
 * themselves.
 */

/**
 * Text somebody wrote: trimmed, and refused when nothing is left. A post of
 * spaces is not a post, and storing one would put an empty line in the feed
 * that nothing can remove.
 */
function textSchema(max: number) {
  return z
    .string()
    .max(max)
    .transform((value) => value.trim())
    .refine((value) => value !== "");
}

/**
 * The images a post is written with, by the identifiers their uploads answered
 * with, in the order they go on the post.
 *
 * Bounded here at a number no post reaches, so a request cannot make the
 * service look up thousands of files; how many a post may carry is the
 * service's rule and its own refusal. A repeated identifier is refused rather
 * than collapsed: it is one picture named twice, and a form that sent it has
 * lost track of what it attached.
 */
const imageIdsSchema = z
  .array(z.string().min(1).max(64))
  .max(20)
  .refine((ids) => new Set(ids).size === ids.length)
  .default([]);

/**
 * A post somebody writes as themselves.
 *
 * Strict, so a request carrying the board's options here - "important",
 * "pinned" - is refused rather than written without them: a writer who meant
 * to post as Styrelsen should learn that it did not happen, not find an
 * ordinary post where a notice was meant to be.
 */
const postSchema = z.strictObject({
  audienceId: z.string().min(1).max(64),
  body: textSchema(POST_MAX_LENGTH),
  imageIds: imageIdsSchema,
});

/**
 * An instant as the API writes one, refused when it is anything else: a value
 * the screen could not have produced is answered rather than repaired.
 */
const instantSchema = z.string().transform((value, ctx) => {
  const instant = new Date(value);
  if (Number.isNaN(instant.getTime()) || instant.toISOString() !== value) {
    ctx.addIssue({ code: "custom", message: "is not an ISO instant" });
    return z.NEVER;
  }
  return instant;
});

/**
 * A post written as Styrelsen: what the board's composer holds.
 *
 * Who may send it is the service's question, asked of the register; this only
 * holds its shape. The title is one line, because it is a news item's heading
 * and a mailing's subject. Every flag is spelled out with its default, so a
 * request that leaves one out means what the composer shows unticked.
 */
const boardPostSchema = z.strictObject({
  audienceId: z.string().min(1).max(64),
  title: textSchema(BOARD_POST_TITLE_MAX_LENGTH).refine(
    (value) => !/[\r\n]/u.test(value),
  ),
  body: textSchema(POST_MAX_LENGTH),
  imageIds: imageIdsSchema,
  namesAuthor: z.boolean(),
  important: z.boolean().default(false),
  pinned: z.boolean().default(false),
  commentsAllowed: z.boolean().default(true),
  scheduledAt: instantSchema.nullable().default(null),
  onWebsite: z.boolean().default(false),
});

/**
 * A post's new text, and nothing else. Strict, so an edit that tried to move a
 * post to another audience or put the board's options on it is refused rather
 * than taken for an edit of the text alone.
 */
const editPostSchema = z.strictObject({
  body: textSchema(POST_MAX_LENGTH),
});

/** A comment's new text, on the same terms as a post's. */
const editCommentSchema = z.strictObject({
  body: textSchema(COMMENT_MAX_LENGTH),
});

const commentSchema = z.strictObject({
  body: textSchema(COMMENT_MAX_LENGTH),
  /** Whether a board seat holder answers as Styrelsen. */
  asBoard: z.boolean().default(false),
});

/**
 * How far the reader has read an audience.
 *
 * An instant the screen supplies rather than the moment of the request, because
 * what it marks is the newest post actually on screen. A marker set to "now" by
 * the server would mark a post read that was written while the request was in
 * flight and that the reader has never seen.
 *
 * Refused when it is not an instant, on the cursor's own reasoning: a value the
 * screen could not have produced is answered rather than repaired.
 */
const readSchema = z.object({ readAt: instantSchema });

/** A cursor the reader handed back, refused rather than read leniently. */
const cursorSchema = z.string().transform((value, ctx) => {
  const cursor = parseFeedCursor(value);
  if (cursor === null) {
    ctx.addIssue({ code: "custom", message: "is not a cursor into the feed" });
    return z.NEVER;
  }
  return cursor;
});

/**
 * What narrows a read: one audience, a search, who wrote it, and whether the
 * board marked it important. Each is optional, and each only narrows.
 */
const feedQuerySchema = z.object({
  audience: z
    .string()
    .min(1)
    .max(64)
    .optional()
    .transform((value) => value ?? null),
  q: z
    .string()
    .max(SEARCH_MAX_LENGTH)
    .optional()
    .transform((value) => {
      const trimmed = value?.trim() ?? "";
      return trimmed === "" ? null : trimmed;
    }),
  from: z
    .enum(["board", "neighbours"])
    .optional()
    .transform((value) => value ?? null),
  important: z
    .enum(["true", "false"])
    .optional()
    .transform((value) => value === "true"),
});

const pageQuerySchema = feedQuerySchema.extend({
  before: cursorSchema.optional().transform((value) => value ?? null),
});

const sinceQuerySchema = feedQuerySchema.extend({ after: cursorSchema });

const commentPageQuerySchema = z.object({
  before: cursorSchema.optional().transform((value) => value ?? null),
});

const commentSinceQuerySchema = z.object({ after: cursorSchema });

/**
 * The principal the global guard attached.
 *
 * Every route here is authenticated, so a request that reaches a handler without
 * one is a wiring fault rather than a caller to answer.
 */
export function requirePrincipal(request: RequestWithPrincipal): Principal {
  const principal = request.principal;
  if (principal === undefined) {
    throw new Error("The authorization guard did not attach a principal.");
  }
  return principal;
}

@Controller("api/feed")
@RequireCapability("chat:participate")
export class FeedController {
  constructor(
    private readonly feed: FeedService,
    private readonly comments: PostCommentService,
    private readonly board: BoardPostService,
  ) {}

  @Get("audiences")
  async audiences(
    @Req() request: RequestWithPrincipal,
  ): Promise<AudienceListView> {
    return this.feed.audiences(requirePrincipal(request));
  }

  @Post("audiences/:audienceId/read")
  @HttpCode(200)
  async markAudienceRead(
    @Param("audienceId") audienceId: string,
    @Body() body: unknown,
    @Req() request: RequestWithPrincipal,
  ): Promise<{ readAt: string }> {
    const input = readSchema.parse(body);
    return this.feed.markAudienceRead(
      requirePrincipal(request),
      audienceId,
      input.readAt,
    );
  }

  @Get("posts")
  async page(
    @Query() query: unknown,
    @Req() request: RequestWithPrincipal,
  ): Promise<FeedPage> {
    const input = pageQuerySchema.parse(query);
    return this.feed.page(
      requirePrincipal(request),
      {
        audienceId: input.audience,
        search: input.q,
        from: input.from,
        important: input.important,
      },
      input.before,
    );
  }

  /*
   * Declared before the post's own route, so "since" is never read as a post's
   * identifier.
   */
  @Get("posts/since")
  async since(
    @Query() query: unknown,
    @Req() request: RequestWithPrincipal,
  ): Promise<FeedUpdate> {
    const input = sinceQuerySchema.parse(query);
    return this.feed.since(
      requirePrincipal(request),
      {
        audienceId: input.audience,
        search: input.q,
        from: input.from,
        important: input.important,
      },
      input.after,
    );
  }

  @Get("posts/:postId")
  async post(
    @Param("postId") postId: string,
    @Req() request: RequestWithPrincipal,
  ): Promise<PostView> {
    return this.feed.post(requirePrincipal(request), postId);
  }

  @Post("posts")
  @HttpCode(201)
  async write(
    @Body() body: unknown,
    @Req() request: RequestWithPrincipal,
  ): Promise<PostView> {
    const input = postSchema.parse(body);
    return this.feed.write(requirePrincipal(request), input);
  }

  /**
   * Writes a post as Styrelsen, which is a news item (ADR 0026).
   *
   * A route of its own rather than options on the one above, because it is a
   * different act with a different answer to who may do it: the board's, asked
   * of the register by the service, and published through the news module's
   * own path with the audit entries that path writes.
   */
  @Post("board-posts")
  @HttpCode(201)
  async writeAsBoard(
    @Body() body: unknown,
    @Req() request: RequestWithPrincipal,
  ): Promise<PostView> {
    const input = boardPostSchema.parse(body);
    return this.board.write(
      requirePrincipal(request),
      input,
      webActor(request),
    );
  }

  /**
   * Withdraws a post the board scheduled, before its instant (its news item
   * and the post with it). Refused once it has been published.
   */
  @Delete("board-posts/:postId")
  @HttpCode(204)
  async withdrawBoardPost(
    @Param("postId") postId: string,
    @Req() request: RequestWithPrincipal,
  ): Promise<void> {
    await this.board.withdraw(requirePrincipal(request), postId);
  }

  /** Edits a post its author wrote as themselves, keeping what it said. */
  @Patch("posts/:postId")
  async edit(
    @Param("postId") postId: string,
    @Body() body: unknown,
    @Req() request: RequestWithPrincipal,
  ): Promise<PostView> {
    const input = editPostSchema.parse(body);
    return this.feed.edit(requirePrincipal(request), postId, input.body);
  }

  /** A post's earlier versions: for its author and the board. */
  @Get("posts/:postId/revisions")
  async history(
    @Param("postId") postId: string,
    @Req() request: RequestWithPrincipal,
  ): Promise<RevisionListView> {
    return this.feed.history(requirePrincipal(request), postId);
  }

  /**
   * Who in an important post's audience has not opened it: the board's
   * must-read list.
   */
  @Get("posts/:postId/not-read")
  async notRead(
    @Param("postId") postId: string,
    @Req() request: RequestWithPrincipal,
  ): Promise<NotReadView> {
    return this.feed.notRead(requirePrincipal(request), postId);
  }

  /** Pins a post written as Styrelsen to the top of the feed. */
  @Put("posts/:postId/pin")
  async pin(
    @Param("postId") postId: string,
    @Req() request: RequestWithPrincipal,
  ): Promise<PostView> {
    return this.board.pin(requirePrincipal(request), postId, true);
  }

  /** Takes the pin off a post written as Styrelsen. */
  @Delete("posts/:postId/pin")
  async unpin(
    @Param("postId") postId: string,
    @Req() request: RequestWithPrincipal,
  ): Promise<PostView> {
    return this.board.pin(requirePrincipal(request), postId, false);
  }

  /**
   * Uploads an image for a post this person is about to write.
   *
   * Multipart rather than JSON, like an issue's photograph: the bytes travel as
   * bytes, and the size limit is enforced by the parser as they arrive rather
   * than after the whole body is in the process. One file per request, and the
   * post names its images afterwards.
   */
  @Post("images")
  @HttpCode(201)
  async uploadImage(
    @Req() request: RequestWithPrincipal,
  ): Promise<PostImageView> {
    const principal = requirePrincipal(request);

    const file = await readSingleFile(request).catch((cause: unknown) => {
      if (isTooLarge(cause)) {
        throw new MediaError("The file is larger than allowed.", "too-large");
      }
      throw cause;
    });
    if (file === null) {
      throw new MediaError("The request carried no file.", "no-file");
    }

    return this.feed.uploadImage(principal, {
      bytes: file.bytes,
      fileName: file.fileName,
    });
  }

  @Post("posts/:postId/read")
  @HttpCode(200)
  async markPostRead(
    @Param("postId") postId: string,
    @Req() request: RequestWithPrincipal,
  ): Promise<PostReadView> {
    return this.feed.markPostRead(requirePrincipal(request), postId);
  }

  @Put("posts/:postId/like")
  async like(
    @Param("postId") postId: string,
    @Req() request: RequestWithPrincipal,
  ): Promise<LikeView> {
    return this.feed.like(requirePrincipal(request), postId, true);
  }

  @Delete("posts/:postId/like")
  async unlike(
    @Param("postId") postId: string,
    @Req() request: RequestWithPrincipal,
  ): Promise<LikeView> {
    return this.feed.like(requirePrincipal(request), postId, false);
  }

  @Get("posts/:postId/comments")
  async commentPage(
    @Param("postId") postId: string,
    @Query() query: unknown,
    @Req() request: RequestWithPrincipal,
  ): Promise<PostCommentPage> {
    const { before } = commentPageQuerySchema.parse(query);
    return this.comments.page(requirePrincipal(request), postId, before);
  }

  /** What has been written under a post since a cursor: an open thread's poll. */
  @Get("posts/:postId/comments/since")
  async commentsSince(
    @Param("postId") postId: string,
    @Query() query: unknown,
    @Req() request: RequestWithPrincipal,
  ): Promise<PostCommentUpdate> {
    const { after } = commentSinceQuerySchema.parse(query);
    return this.comments.since(requirePrincipal(request), postId, after);
  }

  @Post("posts/:postId/comments")
  @HttpCode(201)
  async comment(
    @Param("postId") postId: string,
    @Body() body: unknown,
    @Req() request: RequestWithPrincipal,
  ): Promise<PostCommentView> {
    const input = commentSchema.parse(body);
    return this.comments.write(requirePrincipal(request), postId, input.body, {
      asBoard: input.asBoard,
    });
  }

  /** Edits a comment its writer wrote, keeping what it said. */
  @Patch("comments/:commentId")
  async editComment(
    @Param("commentId") commentId: string,
    @Body() body: unknown,
    @Req() request: RequestWithPrincipal,
  ): Promise<PostCommentView> {
    const input = editCommentSchema.parse(body);
    return this.comments.edit(requirePrincipal(request), commentId, input.body);
  }

  /** A comment's earlier versions: for its writer and the board. */
  @Get("comments/:commentId/revisions")
  async commentHistory(
    @Param("commentId") commentId: string,
    @Req() request: RequestWithPrincipal,
  ): Promise<RevisionListView> {
    return this.comments.history(requirePrincipal(request), commentId);
  }

  @Put("comments/:commentId/like")
  async likeComment(
    @Param("commentId") commentId: string,
    @Req() request: RequestWithPrincipal,
  ): Promise<LikeView> {
    return this.comments.like(requirePrincipal(request), commentId, true);
  }

  @Delete("comments/:commentId/like")
  async unlikeComment(
    @Param("commentId") commentId: string,
    @Req() request: RequestWithPrincipal,
  ): Promise<LikeView> {
    return this.comments.like(requirePrincipal(request), commentId, false);
  }
}

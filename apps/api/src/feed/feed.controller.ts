import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
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
  PostCommentPage,
  PostCommentUpdate,
  PostCommentView,
  PostImageView,
  PostReadView,
  PostView,
} from "@openbrf/shared";
import { z } from "zod";

import type { RequestWithPrincipal } from "../authorization/authorization.guard";
import type { Principal } from "../authorization/capabilities";
import { RequireCapability } from "../authorization/require-capability.decorator";
import { isTooLarge, readSingleFile } from "../http/multipart";
import { MediaError } from "../media/media.service";
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
 * Reading the feed and writing to it, for somebody in an audience. Making a
 * group and who is in it are `group.controller.ts`, and what the board does
 * with a post reported out of a group is `post-report.controller.ts`.
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

const postSchema = z.object({
  audienceId: z.string().min(1).max(64),
  body: textSchema(POST_MAX_LENGTH),
  imageIds: imageIdsSchema,
});

const commentSchema = z.object({ body: textSchema(COMMENT_MAX_LENGTH) });

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
    return this.comments.write(requirePrincipal(request), postId, input.body);
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

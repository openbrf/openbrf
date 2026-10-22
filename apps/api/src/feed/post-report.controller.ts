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
import type {
  PostCommentView,
  PostReportQueueView,
  PostReportView,
  PostView,
} from "@openbrf/shared";
import { z } from "zod";

import type { RequestWithPrincipal } from "../authorization/authorization.guard";
import { RequireCapability } from "../authorization/require-capability.decorator";
import { cursorSchema, requirePrincipal } from "./feed.controller";
import { FeedService } from "./feed.service";
import { PostCommentService } from "./post-comment.service";
import {
  PostReportService,
  REPORT_NOTE_MAX_LENGTH,
} from "./post-report.service";

/**
 * Reporting a post or a comment, and what the board does about one.
 *
 * Two kinds of caller on one path, and the capability is declared per route rather
 * than on the class. Reporting is done by somebody who reads the post and needs
 * `chat:participate`; reading the queue and striking through are the board's and
 * need `chat:moderate`. One decorator on the class would open one half of this
 * file to the wrong half of the house.
 *
 * The routes that answer a report take a report identifier. The two that take
 * a post or a comment strike in Alla and nowhere else: the board's whole way
 * into a group is a report from inside it, so a board member cannot strike a
 * group's post nobody reported, and cannot ask about a group at all.
 *
 * `chat:moderate` is what opens the board's routes, and it is not the whole of
 * what they ask: the service then asks the register for a board seat, because
 * the administrator holds every capability and holds no seat. The division is
 * the groups' own - the capability opens the endpoint, the register decides what
 * is behind it - and it is stated once, in the service, rather than five times
 * here.
 */

/**
 * What the reporter wants to say about it.
 *
 * Optional, because what was reported travels with the report and a reporter
 * who has nothing to add should not have to invent something. Trimmed to null
 * when it is empty, so a note is either words or nothing.
 */
const noteSchema = z
  .string()
  .max(REPORT_NOTE_MAX_LENGTH)
  .optional()
  .transform((value) => {
    const trimmed = value?.trim() ?? "";
    return trimmed === "" ? null : trimmed;
  });

/** A post or a comment, and never both: a report carries one thing. */
const reportSchema = z.union([
  z.strictObject({ postId: z.string().min(1).max(64), note: noteSchema }),
  z.strictObject({ commentId: z.string().min(1).max(64), note: noteSchema }),
]);

const queueQuerySchema = z.object({
  after: cursorSchema.optional().transform((value) => value ?? null),
});

@Controller("api/feed")
export class PostReportController {
  constructor(
    private readonly reports: PostReportService,
    private readonly feed: FeedService,
    private readonly comments: PostCommentService,
  ) {}

  @Post("reports")
  @HttpCode(201)
  @RequireCapability("chat:participate")
  async report(
    @Body() body: unknown,
    @Req() request: RequestWithPrincipal,
  ): Promise<{ reportId: string }> {
    const input = reportSchema.parse(body);
    return this.reports.report(
      requirePrincipal(request),
      "postId" in input
        ? { postId: input.postId }
        : { commentId: input.commentId },
      input.note,
    );
  }

  /**
   * What the board has been asked to look at, a page at a time.
   *
   * It lists reported posts and comments and never groups. A board that has had
   * no report from a group reads no trace of one, which is also the whole of
   * what it can learn about whether this cooperative has any groups at all. An
   * account holding the capability and no seat is told that the queue is not
   * theirs, rather than that nothing has been reported.
   */
  @Get("reports")
  @RequireCapability("chat:moderate")
  async queue(
    @Query() query: unknown,
    @Req() request: RequestWithPrincipal,
  ): Promise<PostReportQueueView> {
    const input = queueQuerySchema.parse(query);
    return this.reports.queue(requirePrincipal(request), input.after);
  }

  @Post("reports/:reportId/strike")
  @HttpCode(200)
  @RequireCapability("chat:moderate")
  async strike(
    @Param("reportId") reportId: string,
    @Req() request: RequestWithPrincipal,
  ): Promise<PostReportView> {
    return this.reports.strike(requirePrincipal(request), reportId);
  }

  @Post("reports/:reportId/dismiss")
  @HttpCode(200)
  @RequireCapability("chat:moderate")
  async dismiss(
    @Param("reportId") reportId: string,
    @Req() request: RequestWithPrincipal,
  ): Promise<PostReportView> {
    return this.reports.dismiss(requirePrincipal(request), reportId);
  }

  /**
   * Strikes a resident's post in Alla through, without a report, and answers
   * the post as the board now reads it.
   */
  @Post("posts/:postId/strike")
  @HttpCode(200)
  @RequireCapability("chat:moderate")
  async strikePost(
    @Param("postId") postId: string,
    @Req() request: RequestWithPrincipal,
  ): Promise<PostView> {
    const principal = requirePrincipal(request);
    await this.reports.strikePost(principal, postId);
    return this.feed.post(principal, postId);
  }

  /**
   * Strikes a comment under a post in Alla through, without a report, and
   * answers the comment as the board now reads it.
   */
  @Post("comments/:commentId/strike")
  @HttpCode(200)
  @RequireCapability("chat:moderate")
  async strikeComment(
    @Param("commentId") commentId: string,
    @Req() request: RequestWithPrincipal,
  ): Promise<PostCommentView> {
    const principal = requirePrincipal(request);
    const struck = await this.reports.strikeComment(principal, commentId);
    return this.comments.comment(principal, struck, new Date());
  }
}

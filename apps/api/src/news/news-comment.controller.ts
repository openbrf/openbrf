import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Req,
} from "@nestjs/common";
import { z } from "zod";

import type { RequestWithPrincipal } from "../authorization/authorization.guard";
import type { Principal } from "../authorization/capabilities";
import { RequireCapability } from "../authorization/require-capability.decorator";
import {
  NEWS_COMMENT_MAX_LENGTH,
  type NewsCommentView,
  NewsCommentService,
} from "./news-comment.service";

/**
 * Comments on the association's news, over HTTP.
 *
 * Two controllers because there are two audiences and a capability belongs on a
 * class: a resident reads the thread and writes into it, and the board strikes a
 * comment through. One class carrying both would be a route open to the wrong
 * half of them, which is the argument the issues module's three controllers
 * make.
 *
 * Every route here is authenticated, and that is the whole of the visibility
 * story on the write side. There is no @Public() route in this file and there
 * will not be one: the association's website takes no authenticated writes and
 * reads no session, so a comment form there would be either anonymous or a login
 * wall on a page that promises neither. See the service's class comment.
 */

const bodySchema = z.object({
  /*
   * Trimmed, and refused when nothing is left. A comment of spaces is not a
   * comment, and storing one would put an empty strike-through-able row under
   * somebody's notice.
   */
  body: z
    .string()
    .max(NEWS_COMMENT_MAX_LENGTH)
    .transform((value) => value.trim())
    .refine((value) => value !== ""),
});

/**
 * The acting person, or a fault.
 *
 * The global guard attaches a principal to every non-public route or rejects it,
 * so reaching this throw means the guard stopped doing that, and a 500 naming
 * the guard is the honest answer.
 */
function requirePrincipal(request: RequestWithPrincipal): Principal {
  const principal = request.principal;
  if (principal === undefined) {
    throw new Error("The authorization guard did not attach a principal.");
  }
  return principal;
}

/** Reading a news item's thread, and writing into it. */
@Controller("api/news-comments")
@RequireCapability("news:comment")
export class NewsCommentController {
  constructor(private readonly comments: NewsCommentService) {}

  @Get(":newsId")
  async list(
    @Param("newsId") newsId: string,
    @Req() request: RequestWithPrincipal,
  ): Promise<NewsCommentView[]> {
    return this.comments.list(newsId, requirePrincipal(request));
  }

  @Post(":newsId")
  @HttpCode(201)
  async write(
    @Param("newsId") newsId: string,
    @Body() body: unknown,
    @Req() request: RequestWithPrincipal,
  ): Promise<NewsCommentView> {
    const input = bodySchema.parse(body);
    return this.comments.write({
      newsId,
      authorPersonId: requirePrincipal(request).personId,
      body: input.body,
    });
  }
}

/**
 * Moderating a thread.
 *
 * `site:manage`, which is what the board already holds for publishing in the
 * cooperative's name: a comment thread under a notice is part of what the
 * association publishes, and a capability minted for this alone would have the
 * same grant list under a second name.
 *
 * Its own base path rather than a route under the reading controller, because
 * the capability covers the whole class - one @RequireCapability("news:comment")
 * and one @RequireCapability("site:manage") on the same controller would be a
 * route open to the wrong half of the house.
 *
 * There is one route and no counterpart to it. Hiding is a dated close and
 * nothing clears it, so there is nothing to un-hide: what the board can do to a
 * comment is strike it through, and what it cannot do is make one disappear.
 */
@Controller("api/news-comment-moderation")
@RequireCapability("site:manage")
export class NewsCommentModerationController {
  constructor(private readonly comments: NewsCommentService) {}

  @Post(":id/hide")
  async hide(
    @Param("id") id: string,
    @Req() request: RequestWithPrincipal,
  ): Promise<NewsCommentView> {
    return this.comments.hide(id, requirePrincipal(request).personId);
  }
}

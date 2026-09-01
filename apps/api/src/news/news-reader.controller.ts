import { Controller, Get } from "@nestjs/common";

import { RequireCapability } from "../authorization/require-capability.decorator";
import {
  type NewsArticleView,
  NewsCommentService,
} from "./news-comment.service";

/**
 * The association's news, as the people who live in the house read it inside the
 * application.
 *
 * A third controller in this module rather than a route on the thread's own,
 * because a news item and a comment are two resources and one class per resource
 * is how the rest of this codebase is laid out. It carries the same capability as
 * the reading half of the thread, which is the point: the rule that a comment is
 * exactly as visible as its news item is only true if one capability governs
 * both, and two capabilities over one rule would be two answers waiting to
 * disagree. Splitting a controller is about not mixing two capabilities in one
 * class, not about giving each capability exactly one class.
 *
 * `news:comment` is a resident's, and the board holds it too. An external
 * property manager holds neither it nor `site:manage`: they handle the
 * association's issues and do not live in the building, so the notices addressed
 * to the house are not theirs to read here.
 *
 * That makes this endpoint strictly narrower than the website it duplicates -
 * /nyheter serves a public item to anybody at all and a member-only one to
 * anybody signed in. Narrower is the safe direction and it is deliberate: this
 * answer carries the identifier a thread is addressed by, and the association's
 * website is the place to read a notice without an account.
 */
@Controller("api/news-reader")
@RequireCapability("news:comment")
export class NewsReaderController {
  constructor(private readonly comments: NewsCommentService) {}

  @Get()
  async list(): Promise<NewsArticleView[]> {
    return this.comments.commentableNews();
  }
}

import { Controller, Get, Param, Req, Res } from "@nestjs/common";
import type { FastifyReply, FastifyRequest } from "fastify";

import { AuthService } from "../auth/auth.service";
import { Public } from "../authorization/public.decorator";
import { isSlugShaped } from "./pages.service";
import { SiteNewsService } from "./site-news.service";
import { acceptLanguage, hasSession } from "./site-request";
import { SITE_HTML_HEADERS, SiteRenderer } from "./site-renderer.service";

/**
 * The association's news, on the association's own website.
 *
 * A controller of its own rather than two more routes on the page controller,
 * for the reason the board's screen is a separate class from the public one:
 * these two answer different questions about the same website, and a file that
 * answers one of them is a file that can be read in full.
 *
 * Static paths, so Fastify ranks them above the page controller's :slug
 * parameter and the address /nyheter is the news index rather than a page
 * somebody wrote at that name. That is also why "nyheter" is a reserved slug:
 * a page claiming it could never be opened, and the board is told so when it
 * tries rather than discovering it afterwards.
 *
 * Public in the same strong sense the pages are. No route here reads a
 * capability and none of them can; what a session buys is one thing only, that
 * a member-only item becomes readable, and the refusal is identical for
 * everyone.
 */
@Public()
@Controller()
export class SiteNewsController {
  constructor(
    private readonly news: SiteNewsService,
    private readonly renderer: SiteRenderer,
    private readonly auth: AuthService,
  ) {}

  /** Everything published that this reader may see, newest first. */
  @Get("nyheter")
  async index(
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const session = await hasSession(this.auth, request);
    const items = await this.news.list(session);

    this.send(
      reply,
      200,
      await this.renderer.newsIndex(acceptLanguage(request), items, {
        hasSession: session,
        // A news document carries no blocks, so nothing on it varies by
        // person. Named all the same, because the visit is what the renderer
        // is told about this request and a caller that had not thought about
        // it should have to say so.
        personId: null,
      }),
    );
  }

  /**
   * One news item by its address.
   *
   * Three situations end here with the same answer: the address names nothing,
   * the item is not published, and the item is for the members and the visitor
   * has no session. The service returns one null for all three and this method
   * has one 404 to send - the website's own, byte for byte the document a page
   * that was never written produces - so nobody learns which of the three it
   * was.
   */
  @Get("nyheter/:slug")
  async article(
    @Param("slug") slug: string,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    /*
     * Read before the shape is checked, because the chrome needs it whichever
     * way this goes - and read once: the article and the menu around it have
     * to agree about who is asking.
     */
    const session = await hasSession(this.auth, request);
    const article = isSlugShaped(slug)
      ? await this.news.bySlug(slug, session)
      : null;

    if (article === null) {
      this.send(
        reply,
        404,
        await this.renderer.notFound(acceptLanguage(request)),
      );
      return;
    }

    this.send(
      reply,
      200,
      await this.renderer.newsArticle(acceptLanguage(request), article, {
        hasSession: session,
        personId: null,
      }),
    );
  }

  private send(reply: FastifyReply, status: number, html: string): void {
    void reply.code(status).headers(SITE_HTML_HEADERS).send(html);
  }
}

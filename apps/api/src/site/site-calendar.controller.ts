import { Controller, Get, Param, Req, Res } from "@nestjs/common";
import type { FastifyReply, FastifyRequest } from "fastify";

import { AuthService } from "../auth/auth.service";
import { Public } from "../authorization/public.decorator";
import { isSlugShaped } from "./pages.service";
import { CALENDAR_MONTH_PARAM, SiteEventsService } from "./site-events.service";
import { acceptLanguage, hasSession, queryValue } from "./site-request";
import { SITE_HTML_HEADERS, SiteRenderer } from "./site-renderer.service";

/**
 * The association's calendar, on the association's own website.
 *
 * A controller of its own rather than two more routes on the page controller,
 * for the reason the news controller gives: these answer a different question
 * about the same website, and a file that answers one of them is a file that
 * can be read in full.
 *
 * Static paths, so route matching ranks them above the page controller's :slug
 * parameter and the address /kalender is the calendar rather than a page
 * somebody wrote at that name. That is also why "kalender" is a reserved slug:
 * a page claiming it could never be opened, and the board is told so when it
 * tries rather than discovering it afterwards.
 *
 * Public in the same strong sense the pages are. No route here reads a
 * capability and none of them can; what a session buys is one thing only, that
 * the members' events become readable, and the refusal is identical for
 * everyone.
 *
 * ## No script, and so no month navigation in the browser
 *
 * The month is a query parameter and the way between months is two anchors. The
 * content policy on every response names no script source at all, so a calendar
 * that needed one would not run; a calendar that needs none works with
 * JavaScript switched off, in a text browser, and from a printed page's own
 * address. What the parameter may say is bounded by the service - the strict
 * read and the clamp are one answer, given there - so nothing a visitor puts in
 * the address bar reaches a query.
 *
 * ## Nothing about the instance is checked first
 *
 * Unlike the broker information page, which refuses an instance nobody has
 * claimed. An unclaimed instance has published no events, so the calendar
 * answers with an empty month - which is the truth about it, and the same answer
 * the news index gives.
 */
@Public()
@Controller()
export class SiteCalendarController {
  constructor(
    private readonly events: SiteEventsService,
    private readonly renderer: SiteRenderer,
    private readonly auth: AuthService,
  ) {}

  /**
   * One month of the calendar, this month unless a link said otherwise.
   *
   * The parameter is handed on as it arrived. Reading it is the service's, so
   * that what a month may be is decided in one place: a value that is not a
   * month leaves the reader on the current one, and a month outside the span the
   * calendar reaches is pulled to the nearest edge rather than refused - there
   * is nothing here a visitor could have got wrong.
   */
  @Get("kalender")
  async month(
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const session = await hasSession(this.auth, request);
    const page = await this.events.month(
      session,
      queryValue(request, CALENDAR_MONTH_PARAM),
    );

    this.send(
      reply,
      200,
      await this.renderer.calendar(acceptLanguage(request), page, {
        hasSession: session,
        // A calendar document carries no blocks, so nothing on it varies by
        // person. Named all the same, because the visit is what the renderer is
        // told about this request and a caller that had not thought about it
        // should have to say so.
        personId: null,
      }),
    );
  }

  /**
   * One event by its address.
   *
   * Three situations end here with the same answer: the address names nothing,
   * the event is not published, and the event is for the members and the visitor
   * has no session. The service returns one null for all three and this method
   * has one 404 to send - the website's own, byte for byte the document a page
   * that was never written produces - so nobody learns which of the three it
   * was.
   */
  @Get("kalender/:eventId")
  async event(
    @Param("eventId") eventId: string,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    /*
     * Read before the identifier is checked, because the chrome needs it
     * whichever way this goes - and read once: the event and the menu around it
     * have to agree about who is asking.
     */
    const session = await hasSession(this.auth, request);
    /*
     * The same shape check a news item's address gets, and it is the right one:
     * an identifier is a path segment, and the question "is this shaped like an
     * address at all" has one answer on this website. A segment that is not is
     * answered as an address naming nothing, without a query being sent.
     */
    const event = isSlugShaped(eventId)
      ? await this.events.byId(eventId, session)
      : null;

    if (event === null) {
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
      await this.renderer.event(acceptLanguage(request), event, {
        hasSession: session,
        personId: null,
      }),
    );
  }

  private send(reply: FastifyReply, status: number, html: string): void {
    void reply.code(status).headers(SITE_HTML_HEADERS).send(html);
  }
}

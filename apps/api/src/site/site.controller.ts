import { Controller, Get, Param, Req, Res } from "@nestjs/common";
import type { FastifyReply, FastifyRequest } from "fastify";

import { AuthService } from "../auth/auth.service";
import { Public } from "../authorization/public.decorator";
import { APP_BASE_PATH } from "../http/app-base-path";
import { isApiRequest } from "../http/serve-single-page-app";
import { SetupService } from "../setup/setup.service";
import { PagesService } from "./pages.service";
import {
  siteFormKind,
  SITE_FORM_REFUSED_PARAM,
  SITE_FORM_SENT_PARAM,
} from "./site-forms";
import { acceptLanguage, sessionPersonId } from "./site-request";
import {
  SITE_HTML_HEADERS,
  SiteRenderer,
  type SiteSubmissionState,
} from "./site-renderer.service";

/**
 * The association's own website, at the root of its own domain.
 *
 * This is the only part of the product a person with no account ever sees, and
 * it is deliberately the plainest thing in the codebase: server-rendered HTML,
 * one inline stylesheet, no JavaScript, no cookie set, nothing fetched from a
 * third party. A housing cooperative publishing to its residents and to the
 * street should not be handing anyone's address to an analytics vendor, and the
 * simplest way to be sure of that is to have nothing to switch off.
 *
 * Public, and public in the strongest sense: no route here reads a capability
 * and none of them can. What a member's session buys is one thing only - a page
 * the board marked MEMBER becomes readable. Everything else is identical for
 * everyone, including the refusal.
 *
 * Registered at the root, so its parameter route sits directly above the
 * catch-all that serves the single-page application. Fastify ranks a static
 * path above a parameter and a parameter above a wildcard, which is what keeps
 * /health, /app and every real file out of the page lookup.
 */
@Public()
@Controller()
export class SiteController {
  constructor(
    private readonly pages: PagesService,
    private readonly renderer: SiteRenderer,
    private readonly setup: SetupService,
    private readonly auth: AuthService,
  ) {}

  /**
   * The front page.
   *
   * An unclaimed instance sends every visitor to the setup wizard instead. The
   * statement "an instance nobody has claimed asks the first visitor to claim
   * it" is then literally true of the address an operator actually types, which
   * is the address they were given.
   */
  @Get()
  async home(
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    if ((await this.setup.state()).setupRequired) {
      void reply.redirect(`${APP_BASE_PATH}/setup`, 302);
      return;
    }

    const page = await this.pages.homePage();
    if (page === null) {
      await this.sendNotFound(request, reply);
      return;
    }

    /*
     * The front page is public whoever asks; what is around it is not. A
     * member is shown the menu entries a member may open, and a news teaser
     * block on the page shows them the members' items among the public ones,
     * exactly as the news index would. The session is read for those two
     * things and for nothing else - it never decides which page the root
     * serves. What the query string says was just submitted travels with it,
     * so a form on the front page shows its confirmation where it stood.
     */
    const personId = await sessionPersonId(this.auth, request);
    this.send(
      reply,
      200,
      await this.renderer.page(acceptLanguage(request), page, {
        hasSession: personId !== null,
        personId,
        ...submissionState(request),
      }),
    );
  }

  /**
   * The broker information page.
   *
   * A generated page rather than one the board wrote, so it has a route of its
   * own instead of a row in the page table: what stands on it is the facts the
   * board recorded on its own screen, and there is nothing here for anyone to
   * edit as a page. Both addresses answer with the same document, and both are
   * reserved slugs for that reason - a static path outranks the page parameter
   * below, so a page written at either would simply never be reached.
   *
   * Declared above the parameter route, like the preview route on the board's
   * own controller, so the word is never read as a page's address.
   *
   * There is no member-only variant and no visibility to set. A broker page
   * that only members could read would be a broker page nobody asks for, and
   * the facts on it are the association's own account of itself. The menu
   * around it is still the visitor's own, like the front page's: the page is
   * public to everybody, and the chrome is what each reader is entitled to.
   */
  @Get(["maklarinfo", "broker"])
  async broker(
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    /*
     * An instance nobody has claimed publishes nothing. The front page sends
     * such a visitor to the setup wizard, which is right for the address an
     * operator types and wrong for this one: a deep link a broker followed is
     * answered with the website's own not-found document rather than with a
     * form asking them to claim somebody else's housing cooperative.
     */
    const claimed = !(await this.setup.state()).setupRequired;
    const personId = claimed ? await sessionPersonId(this.auth, request) : null;
    const html = claimed
      ? await this.renderer.broker(acceptLanguage(request), {
          hasSession: personId !== null,
          personId,
        })
      : null;

    if (html === null) {
      await this.sendNotFound(request, reply);
      return;
    }

    this.send(reply, 200, html);
  }

  /**
   * One page by its address.
   *
   * Three different situations end here with the same answer: the address names
   * no page, the page exists but is not published, and the page is member-only
   * and the visitor has no session. The service returns one null for all three
   * and this method has one 404 to send, byte for byte the same document - so
   * an anonymous visitor learns nothing about which of the three it was, and no
   * future change can make it leak by accident without deleting that null.
   */
  @Get(":slug")
  async page(
    @Param("slug") slug: string,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    // A single-segment API path - "/api" itself - reaches this parameter route,
    // because there is no static route of that name for Fastify to prefer. It
    // belongs to the API's JSON 404, not to the website's HTML one, and the
    // deployed instance is asserted on that in 91-startup-and-connection-urls.
    if (isApiRequest(request.url)) {
      void reply.code(404).send({ reason: "not-found" });
      return;
    }

    const personId = await sessionPersonId(this.auth, request);
    const session = personId !== null;
    const page = await this.pages.bySlug(slug, session);
    if (page === null) {
      await this.sendNotFound(request, reply);
      return;
    }

    this.send(
      reply,
      200,
      await this.renderer.page(acceptLanguage(request), page, {
        hasSession: session,
        personId,
        ...submissionState(request),
      }),
    );
  }

  private async sendNotFound(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    this.send(
      reply,
      404,
      await this.renderer.notFound(acceptLanguage(request)),
    );
  }

  private send(reply: FastifyReply, status: number, html: string): void {
    void reply.code(status).headers(SITE_HTML_HEADERS).send(html);
  }
}

/**
 * What the visitor has just done on this page, according to the query string.
 *
 * The submit endpoints answer 303 to the page with one of these parameters set,
 * and this is where the page reads it back. Nothing is trusted beyond the two
 * words the parameter may hold: an unrecognised value is nobody having done
 * anything, so the query string can produce a confirmation sentence and no
 * other effect at all. There is nothing here to reflect - the confirmation is
 * a fixed translated sentence - and nothing to store, since the website sets no
 * cookie and keeps no session.
 */
function submissionState(request: FastifyRequest): SiteSubmissionState {
  const query = request.query;
  if (typeof query !== "object" || query === null) {
    return {};
  }
  const values = query as Record<string, unknown>;
  return {
    sent: siteFormKind(oneValue(values[SITE_FORM_SENT_PARAM])),
    refused: siteFormKind(oneValue(values[SITE_FORM_REFUSED_PARAM])),
  };
}

/**
 * One string out of a query parameter, whatever shape it arrived in.
 *
 * A repeated parameter parses to an array. Taking neither of them is the right
 * answer: a caller sending the same name twice is not a browser following a
 * redirect this instance produced.
 */
function oneValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

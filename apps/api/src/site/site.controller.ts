import { Controller, Get, Param, Req, Res } from "@nestjs/common";
import type { FastifyReply, FastifyRequest } from "fastify";

import { AuthService } from "../auth/auth.service";
import { Public } from "../authorization/public.decorator";
import { APP_BASE_PATH } from "../http/app-base-path";
import { isApiRequest } from "../http/serve-single-page-app";
import { SetupService } from "../setup/setup.service";
import { PagesService } from "./pages.service";
import { SITE_HTML_HEADERS, SiteRenderer } from "./site-renderer.service";

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

    this.send(
      reply,
      200,
      await this.renderer.page(acceptLanguage(request), page, {
        // The front page is public whoever asks, but the menu around it is
        // not: a member is shown the entries a member may open.
        hasSession: await this.hasSession(request),
      }),
    );
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

    const hasSession = await this.hasSession(request);
    const page = await this.pages.bySlug(slug, hasSession);
    if (page === null) {
      await this.sendNotFound(request, reply);
      return;
    }

    this.send(
      reply,
      200,
      await this.renderer.page(acceptLanguage(request), page, { hasSession }),
    );
  }

  /**
   * Whether this request carries a valid session.
   *
   * Reads the cookie the browser sent and nothing else. Better Auth's session
   * lookup can produce response headers of its own - a refreshed cookie, most
   * of all - and none of them are copied onto the reply: the website never sets
   * a cookie, and a page that starts setting one on a member's visit would have
   * quietly turned the association's public site into something that tracks its
   * readers.
   *
   * A lookup that fails is nobody. The alternative is a public page that stops
   * rendering because a session row was unreadable, which is the wrong failure
   * for the one surface that has to work for someone with no account at all.
   */
  private async hasSession(request: FastifyRequest): Promise<boolean> {
    const headers = new Headers();
    for (const [name, value] of Object.entries(request.headers)) {
      if (typeof value === "string") {
        headers.append(name, value);
      }
    }

    try {
      return (await this.auth.personIdFromHeaders(headers)) !== null;
    } catch {
      return false;
    }
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

/** The header as one string, whatever shape Fastify parsed it into. */
function acceptLanguage(request: FastifyRequest): string | undefined {
  const value = request.headers["accept-language"];
  return typeof value === "string" ? value : undefined;
}

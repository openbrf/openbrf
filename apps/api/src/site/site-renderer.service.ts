import { Injectable } from "@nestjs/common";

import { PrismaService } from "../database/prisma.service";
import { I18nService } from "../i18n/i18n.service";
import { mediaUrl } from "../media/media.service";
import { ThemeService } from "../themes/theme.service";
import { MenuService } from "./menu.service";
import { buildSiteStylesheet } from "./site-css";
import { renderNotFound, renderPage, type SiteChrome } from "./site-html";
import { PagesService, type SitePage } from "./pages.service";
import { visitorLocale } from "./visitor-locale";

/**
 * Everything a public page needs around it: the language, the association's
 * name and mark, and the stylesheet its theme produces.
 *
 * Separate from the controller because two places answer with the website's own
 * 404 - the page routes, and the catch-all that claims every path no route
 * wanted - and those two answers have to be identical. A visitor must not be
 * able to tell a member-only page from a missing one, and they would be able to
 * the moment the two were rendered by different code.
 */

/**
 * The headers every HTML response from the website carries.
 *
 * The content policy is the strictest one that still renders the page: nothing
 * loads by default, the inline stylesheet is allowed because the stylesheet is
 * the theme and it is assembled per instance, images and fonts come from this
 * origin and nowhere else. There is no script-src entry at all, so `default-src
 * 'none'` refuses every script - which is what makes "the website runs no
 * JavaScript" enforced by the browser rather than only true of what we wrote.
 *
 * `vary: cookie` because a member-only page answers differently to a visitor
 * carrying a session, and a cache that missed that would serve one visitor's
 * page to another. `no-cache` for the same reason, one layer down: the response
 * may be stored, but it must be revalidated before it is reused.
 */
export const SITE_HTML_HEADERS: Readonly<Record<string, string>> = {
  "content-type": "text/html; charset=utf-8",
  "x-content-type-options": "nosniff",
  "content-security-policy":
    "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; font-src 'self'",
  "cache-control": "no-cache",
  vary: "cookie",
};

@Injectable()
export class SiteRenderer {
  constructor(
    private readonly prisma: PrismaService,
    private readonly themes: ThemeService,
    private readonly i18n: I18nService,
    private readonly pages: PagesService,
    private readonly menu: MenuService,
  ) {}

  /**
   * One page as a whole document.
   *
   * The session is an argument because the menu depends on it: a member sees
   * the entries for the pages a member may open. It changes nothing else -
   * the page itself was already decided by the caller, which is the one place
   * that may decide it.
   */
  async page(
    acceptLanguage: string | undefined,
    page: SitePage,
    audience: { hasSession: boolean },
  ): Promise<string> {
    return renderPage(
      await this.chrome(acceptLanguage, audience.hasSession),
      page,
    );
  }

  /**
   * The website's own not-found document, in the visitor's language.
   *
   * Rendered with the menu an anonymous visitor gets, whoever asked. The
   * refusal is one document for everybody by construction: a member-only page
   * and an address that names nothing have to answer identically, and the menu
   * is the only part of the chrome that could have differed between them. It
   * is also the one place where showing less costs nothing - somebody who
   * mistyped an address gets the public menu and can find their way from it.
   */
  async notFound(acceptLanguage: string | undefined): Promise<string> {
    return renderNotFound(await this.chrome(acceptLanguage, false));
  }

  /**
   * Reads exactly what the website is allowed to know about the association -
   * what it is called, its mark, its accent, its language and whether it takes
   * account requests - plus its privacy notice and the menu the board
   * arranged.
   *
   * The select list is the boundary. Nothing in this module reaches a register,
   * the address book or the encryption layer, and the shape of this query is
   * where that stops being a claim about intent and becomes a claim about code.
   *
   * The menu is read after the rest rather than beside it, because which
   * entries it may contain depends on an answer from the first query. One
   * extra round trip on a page that is already reading four things is the
   * cheaper half of the trade against asking the association the same question
   * twice.
   */
  private async chrome(
    acceptLanguage: string | undefined,
    hasSession: boolean,
  ): Promise<SiteChrome> {
    const [association, rendering, privacyNoticePath] = await Promise.all([
      this.prisma.association.findUnique({
        where: { id: 1 },
        select: {
          name: true,
          defaultLocale: true,
          logoFileId: true,
          primaryColor: true,
          // Whether the account request form exists at all, which is the one
          // thing that decides if its menu entry is offered. Read here rather
          // than by the menu so one request asks the association one question.
          selfSignupEnabled: true,
        },
      }),
      this.themes.activeRendering(),
      this.pages.privacyNoticePath(),
    ]);

    const menu = await this.menu.siteMenu({
      hasSession,
      selfSignupEnabled: association?.selfSignupEnabled ?? false,
    });

    const locale = visitorLocale(acceptLanguage, association?.defaultLocale);

    return {
      t: this.i18n.translatorFor(locale),
      locale,
      associationName: association?.name ?? "",
      // The mark is recorded PUBLIC when it is uploaded, and the media route
      // streams it from this instance. A visitor's browser therefore fetches it
      // from the origin it is already on, and from no one else.
      logoUrl:
        association?.logoFileId == null
          ? null
          : mediaUrl(association.logoFileId),
      mediaUrl,
      privacyNoticePath,
      menu,
      css: buildSiteStylesheet({
        rendering,
        primaryColor: association?.primaryColor ?? null,
      }),
    };
  }
}

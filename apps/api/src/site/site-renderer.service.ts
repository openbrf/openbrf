import { Injectable } from "@nestjs/common";

import { PrismaService } from "../database/prisma.service";
import { I18nService } from "../i18n/i18n.service";
import { mediaUrl } from "../media/media.service";
import { ThemeService } from "../themes/theme.service";
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
  ) {}

  /** One page as a whole document. */
  async page(
    acceptLanguage: string | undefined,
    page: SitePage,
  ): Promise<string> {
    return renderPage(await this.chrome(acceptLanguage), page);
  }

  /** The website's own not-found document, in the visitor's language. */
  async notFound(acceptLanguage: string | undefined): Promise<string> {
    return renderNotFound(await this.chrome(acceptLanguage));
  }

  /**
   * Reads exactly the four things the website is allowed to know about the
   * association - what it is called, its mark, its accent and its language -
   * and whether it has a privacy notice to link in the footer.
   *
   * The select list is the boundary. Nothing in this module reaches a register,
   * the address book or the encryption layer, and the shape of this query is
   * where that stops being a claim about intent and becomes a claim about code.
   */
  private async chrome(
    acceptLanguage: string | undefined,
  ): Promise<SiteChrome> {
    const [association, rendering, privacyNoticePath] = await Promise.all([
      this.prisma.association.findUnique({
        where: { id: 1 },
        select: {
          name: true,
          defaultLocale: true,
          logoFileId: true,
          primaryColor: true,
        },
      }),
      this.themes.activeRendering(),
      this.pages.privacyNoticePath(),
    ]);

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
      css: buildSiteStylesheet({
        rendering,
        primaryColor: association?.primaryColor ?? null,
      }),
    };
  }
}

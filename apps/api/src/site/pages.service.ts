import { Injectable, Logger } from "@nestjs/common";
import type { TFunction } from "i18next";

import { PrismaService } from "../database/prisma.service";
import type { Prisma } from "../generated/prisma/client";
import {
  PAGE_CONTENT_VERSION,
  type PageBlock,
  type PageContent,
  paragraphsContent,
  readPageContent,
} from "./page-content";

/**
 * What the seeded privacy notice asks the board to answer.
 *
 * The headings a data protection notice needs under GDPR art. 13-14: who the
 * controller is, what is processed, why, for how long, what rights the person
 * has, and where to ask. The order is the order those articles put them in.
 */
const PRIVACY_NOTICE_SECTIONS = [
  "controller",
  "data",
  "purpose",
  "retention",
  "rights",
  "contact",
] as const;

/** Far enough down that the notice is never the lowest, i.e. never the home page. */
const PRIVACY_NOTICE_SORT_ORDER = 1000;

/**
 * A page as the renderer needs it. Deliberately not the database row: nothing
 * downstream has any business knowing when a page was written or by whom.
 */
export interface SitePage {
  slug: string;
  title: string;
  content: PageContent;
}

/**
 * Paths the website may never hand to a page.
 *
 * The single-page application, the API, the liveness probe and the font
 * directory are all served from this origin, and route matching ranks a static
 * path above the page parameter, so a page claiming one of these names would
 * simply never be reached. Refusing the name at the point a page is written is
 * the honest version of that: the board is told the address is taken instead of
 * quietly getting a page nobody can open. The setup wizard is in the list for
 * the same reason - the root redirects an unclaimed instance there.
 */
const RESERVED_SLUGS: ReadonlySet<string> = new Set([
  "app",
  "api",
  "health",
  "fonts",
  "setup",
]);

/**
 * The shape a slug must have.
 *
 * Lowercase, digits and single-position hyphens, starting on an alphanumeric.
 * It is the whole path segment, so it may not contain a slash, a dot or a
 * percent sign: those are the characters that decide what a path means, and a
 * slug carrying one would let a page's address be read as something other than
 * a page.
 */
const SLUG_SHAPE = /^[a-z0-9][a-z0-9-]{0,79}$/;

export function isUsableSlug(slug: string): boolean {
  return SLUG_SHAPE.test(slug) && !RESERVED_SLUGS.has(slug);
}

/**
 * Where the association's privacy notice lives.
 *
 * A constant and not a translated slug, unlike the first page the wizard
 * writes. The notice is linked from the footer of every page and is the address
 * a person is told to go to when they ask what the association does with their
 * data, so it has to be the same address on every instance whatever language
 * the cooperative was set up in.
 *
 * Deliberately not in RESERVED_SLUGS: those are the paths the router claims and
 * a page at one of them could never be opened. This is the opposite - a real
 * page is served here, and the only thing that stops a second page claiming the
 * address is that a slug is unique.
 */
export const PRIVACY_NOTICE_SLUG = "integritetspolicy";

/**
 * The association's own pages, as the public website reads them.
 *
 * Reads only. The editor that writes pages is a later change; what exists here
 * is the half a visitor with no account touches, and it is kept deliberately
 * small: three questions, one of which - "may I see this page" - is answered by
 * returning nothing at all rather than by reporting a refusal.
 *
 * That is the important decision in this file. A member-only page and a page
 * that does not exist both come back as null, so the controller has one answer
 * to give and cannot leak which case it was in. An anonymous visitor asking for
 * /styrelsen learns nothing about whether the association has such a page.
 */
@Injectable()
export class PagesService {
  private readonly logger = new Logger(PagesService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * The page the root serves.
   *
   * The lowest sort order among published public pages, oldest first on a tie.
   * There is no "is the home page" flag: the board arranges a menu, and the
   * first thing in it is the front page. A second way to say which page is
   * first would only be a second way for the two to disagree.
   *
   * Public only. The front door of a housing cooperative's website is not a
   * page that half its visitors are answered with a 404 for.
   */
  async homePage(): Promise<SitePage | null> {
    const row = await this.prisma.page.findFirst({
      where: { published: true, visibility: "PUBLIC" },
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
      select: { slug: true, title: true, content: true },
    });
    return row === null ? null : PagesService.toSitePage(row);
  }

  /**
   * One page by its address, or nothing.
   *
   * Null covers all three of: no such page, a page not published, and a
   * member-only page asked for without a session. One value, so the caller
   * cannot accidentally tell them apart and neither can the visitor.
   */
  async bySlug(slug: string, hasSession: boolean): Promise<SitePage | null> {
    if (!isUsableSlug(slug)) {
      return null;
    }

    const row = await this.prisma.page.findUnique({
      where: { slug },
      select: {
        slug: true,
        title: true,
        content: true,
        published: true,
        visibility: true,
      },
    });

    if (row === null || !row.published) {
      return null;
    }
    if (row.visibility === "MEMBER" && !hasSession) {
      return null;
    }

    return PagesService.toSitePage(row);
  }

  /**
   * Writes the association its first page, once.
   *
   * Called when the setup wizard is completed, so a claimed instance answers
   * its own address with something rather than with a 404. It is the only
   * writer in this service, and it is idempotent in the blunt way: if the
   * instance has any page at all it does nothing, so re-running the wizard from
   * settings later cannot produce a second front page or overwrite what the
   * board has since written.
   *
   * The text is the cooperative's own legal-person facts - its name, its
   * organisation number - and a paragraph of placeholder prose in the visitor's
   * language. Nothing here reaches a register: this file imports no register,
   * no address book and no decryption, which is what makes "the public website
   * cannot publish personal data" a property of the code rather than a promise.
   */
  async seedDefaultPage(
    t: TFunction,
    association: { name: string; organizationNumber: string | null },
  ): Promise<{ created: boolean }> {
    // The privacy notice does not count. It is seeded by the same act of
    // claiming an instance, so counting it would make whether this writes a
    // front page depend on which of the two ran first.
    const existing = await this.prisma.page.count({
      where: { slug: { not: PRIVACY_NOTICE_SLUG } },
    });
    if (existing > 0) {
      return { created: false };
    }

    const slug = t("site.seed.slug");
    if (!isUsableSlug(slug)) {
      // A translated slug is still a URL. Refusing to write an unusable one is
      // better than writing a page that can never be opened.
      this.logger.error(
        `The seeded page's slug "${slug}" is not a usable address; no page was written.`,
      );
      return { created: false };
    }

    const organizationNumber = association.organizationNumber?.trim() ?? "";
    const paragraphs = [
      t("site.seed.body", { association: association.name }),
      organizationNumber === ""
        ? ""
        : t("site.orgNumberLabel", { number: organizationNumber }),
    ];

    await this.prisma.page.create({
      data: {
        slug,
        // A greeting, not the cooperative's name: the name is already the
        // header of every page and the second half of every document title,
        // and a front page that says it three times reads like a placeholder.
        title: t("site.seed.title"),
        // Cast because Prisma types a JSON column with its own recursive
        // InputJsonValue, which a declared object type does not satisfy.
        content: paragraphsContent(
          paragraphs,
        ) as unknown as Prisma.InputJsonObject,
        visibility: "PUBLIC",
        published: true,
        publishedAt: new Date(),
        sortOrder: 0,
      },
    });

    this.logger.log(`Wrote the association's first page at /${slug}`);
    return { created: true };
  }

  /**
   * Writes the association its privacy notice, once.
   *
   * A fill-in page: headings for what a privacy notice has to answer, and a
   * paragraph saying the board writes the rest. There is deliberately no ready
   * text under the headings. What an association actually does with personal
   * data differs between cooperatives, and a canned policy that is wrong about
   * a particular one is worse than an obviously unfinished page - it reads as a
   * statement the board never made.
   *
   * Published and public from the start, because the footer links it from every
   * page: an unpublished notice would mean an instance ships with a link to its
   * own not-found document. It is written with a high sort order so it never
   * becomes the front page, which is the lowest one.
   *
   * Idempotent on the slug rather than on a count, so it can be run at setup and
   * again on boot for an instance claimed before this existed.
   */
  async seedPrivacyNotice(t: TFunction): Promise<{ created: boolean }> {
    const existing = await this.prisma.page.count({
      where: { slug: PRIVACY_NOTICE_SLUG },
    });
    if (existing > 0) {
      return { created: false };
    }

    const content: PageContent = {
      version: PAGE_CONTENT_VERSION,
      blocks: [
        {
          type: "paragraph",
          runs: [{ text: t("site.privacyNotice.intro") }],
        },
        ...PRIVACY_NOTICE_SECTIONS.map((section): PageBlock => ({
          type: "heading",
          level: 2,
          runs: [{ text: t(`site.privacyNotice.sections.${section}`) }],
        })),
      ],
    };

    await this.prisma.page.create({
      data: {
        slug: PRIVACY_NOTICE_SLUG,
        title: t("site.privacyNotice.title"),
        content: content as unknown as Prisma.InputJsonObject,
        visibility: "PUBLIC",
        published: true,
        publishedAt: new Date(),
        // Last among the association's own pages. The front page is the lowest
        // sort order, and a privacy notice is never that.
        sortOrder: PRIVACY_NOTICE_SORT_ORDER,
      },
    });

    this.logger.log(
      `Wrote the association's privacy notice at /${PRIVACY_NOTICE_SLUG}`,
    );
    return { created: true };
  }

  /**
   * The path the footer links the privacy notice at, or nothing.
   *
   * Nothing when the page is missing, unpublished or member-only, because the
   * footer is on every page including the ones an anonymous visitor reads: a
   * link printed there for a page they would be answered 404 for is both a
   * broken link and a hint that the page exists.
   */
  async privacyNoticePath(): Promise<string | null> {
    const row = await this.prisma.page.findUnique({
      where: { slug: PRIVACY_NOTICE_SLUG },
      select: { published: true, visibility: true },
    });
    return row !== null && row.published && row.visibility === "PUBLIC"
      ? `/${PRIVACY_NOTICE_SLUG}`
      : null;
  }

  private static toSitePage(row: {
    slug: string;
    title: string;
    content: unknown;
  }): SitePage {
    return {
      slug: row.slug,
      title: row.title,
      content: readPageContent(row.content),
    };
  }
}

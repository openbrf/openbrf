import { Injectable, Logger } from "@nestjs/common";
import type { TFunction } from "i18next";

import { PrismaService } from "../database/prisma.service";
import type { Prisma } from "../generated/prisma/client";
import type { BuiltInPage, PageStatus } from "../generated/prisma/enums";
import { lockMenu } from "./menu-lock";
import { MenuService } from "./menu.service";
import {
  PAGE_CONTENT_VERSION,
  type PageBlock,
  type PageContent,
  paragraphsContent,
  readPageContent,
} from "./page-content";
import { lockPageOrder } from "./page-order-lock";

/**
 * What the seeded privacy notice asks the board to answer.
 *
 * The headings a data protection notice needs under GDPR art. 13-14: who the
 * controller is, who its data protection officer is, what is processed and why,
 * on what basis and - where that basis is a legitimate interest - which one,
 * who receives it, whether any of it leaves the EU, how long it is kept, what
 * rights the person has including withdrawing a consent, whether giving the
 * data is required and what follows from not giving it, whether any decision is
 * automated, where to complain, and where to ask. The order is the order those
 * articles put them in.
 *
 * Fifteen headings, and the list is what the coverage check reads: a notice
 * missing one is a notice that does not answer something art. 13 requires, and
 * the board is told which one rather than left to compare the article against
 * its own page.
 */
export const PRIVACY_NOTICE_SECTIONS = [
  "controller",
  "dataProtectionOfficer",
  "data",
  "purpose",
  "legalBasis",
  "legitimateInterest",
  "recipients",
  "thirdCountryTransfers",
  "retention",
  "rights",
  "withdrawConsent",
  "provisionRequirement",
  "automatedDecisions",
  "complaint",
  "contact",
] as const;

export type PrivacyNoticeSection = (typeof PRIVACY_NOTICE_SECTIONS)[number];

/** Far enough down that the notice is never the lowest in the board's list. */
const PRIVACY_NOTICE_SORT_ORDER = 1000;

/**
 * A page as the renderer needs it. Deliberately not the database row: nothing
 * downstream has any business knowing when a page was written or by whom.
 */
export interface SitePage {
  slug: string;
  title: string;
  content: PageContent;
  /**
   * Whether an anonymous visitor may read this page.
   *
   * Carried on the page rather than asked for again, because the renderer needs
   * it: a public form on a member-only page would be a form whose submission
   * the endpoint refuses - it resolves the page as an anonymous visitor so that
   * a page nobody may read stays indistinguishable from one that was never
   * written - and a form that cannot be sent is worse than no form.
   *
   * Deliberately not the status value. Nothing downstream has any business
   * knowing how a page is classified; it needs one answer, and this is it.
   */
  publiclyReadable: boolean;
}

/** Every built-in page, in the order the board's list first shows them. */
const BUILT_IN_PAGES: readonly BuiltInPage[] = [
  "NEWS",
  "CALENDAR",
  "BROKER_INFORMATION",
  "REQUEST_ACCOUNT",
];

/** What each built-in page is called until the board calls it something else. */
const BUILT_IN_PAGE_TITLES = {
  NEWS: "site.builtInPages.news",
  CALENDAR: "site.builtInPages.calendar",
  BROKER_INFORMATION: "site.builtInPages.brokerInformation",
  REQUEST_ACCOUNT: "site.builtInPages.requestAccount",
} as const satisfies Record<BuiltInPage, string>;

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
  // The association's news, in both languages the platform speaks. Only the
  // Swedish one is routed, and the English one is held anyway: a page written
  // at /news on an English-speaking cooperative's instance would be reachable
  // today and unreachable the day that route is added, and a page that stops
  // opening is worse than an address that was never free.
  "nyheter",
  "news",
  // The broker information page is generated from the association's recorded
  // facts and is answered at both of these addresses, so a page written at
  // either would never be reached. Both spellings are claimed rather than only
  // the Swedish one: a cooperative keeping its site in English links /broker,
  // and the generated page shadows a written one at whichever it links.
  "maklarinfo",
  "broker",
  // The association's calendar, claimed on the news index's argument and in
  // both languages for the same reason: only the Swedish address is routed, and
  // a page written at /calendar on an English-speaking cooperative's instance
  // would open today and stop opening the day that route is added. One event's
  // own address sits under /kalender, where nothing the router claims is in its
  // way.
  "kalender",
  "calendar",
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

/**
 * Whether a slug is shaped like an address at all.
 *
 * Apart from the reserved list, because not everything addressed by a slug sits
 * at the root: a news item's address is under /nyheter, where nothing the
 * router claims can be in its way, and refusing it the name "api" would be a
 * rule inherited from a namespace it is not in.
 */
export function isSlugShaped(slug: string): boolean {
  return SLUG_SHAPE.test(slug);
}

export function isUsableSlug(slug: string): boolean {
  return isSlugShaped(slug) && !RESERVED_SLUGS.has(slug);
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

  constructor(
    private readonly prisma: PrismaService,
    private readonly menu: MenuService,
  ) {}

  /**
   * The page the root serves.
   *
   * The front page the board chose. That is a setting on the page and never
   * the menu's order: a board dragging an entry is arranging its menu, and a
   * front page that moved because of it was one nobody had chosen.
   *
   * With none chosen, the root answers as it did before there was a choice to
   * make: the menu's first page entry anybody may read, and for a menu that
   * names none, the lowest sort order among public pages, oldest first on a
   * tie, leaving out the privacy notice and the built-in pages, which have no
   * body of their own to serve. An instance whose only public page is
   * the notice answers not-found at the root rather than serve it as the front
   * page. Those fallbacks are what keep the front door open on an instance
   * whose board has not chosen yet - one upgraded with no public page, or one
   * whose every public page has since been removed.
   *
   * Public only, every way round. The front door of a housing cooperative's
   * website is not a page that half its visitors are answered with a 404 for.
   */
  async homePage(): Promise<SitePage | null> {
    /*
     * Public in the query as well as by the CHECK that keeps a front page
     * public: the root is the one address on the site that never asks who is
     * reading, so it does not rest on a constraint it cannot see from here.
     */
    const front = await this.prisma.page.findFirst({
      where: { frontPage: true, status: "PUBLIC" },
      select: { slug: true, title: true, content: true, status: true },
    });
    if (front !== null) {
      return PagesService.toSitePage(front);
    }

    const chosen = await this.menu.homePageSlug();
    if (chosen !== null) {
      const named = await this.prisma.page.findUnique({
        where: { slug: chosen },
        select: { slug: true, title: true, content: true, status: true },
      });
      /*
       * Asked again here, though the menu only ever names a page anybody may
       * read. The menu answered from its own query, and what the root serves
       * is decided by this one: a page closed between the two would otherwise
       * be served to a visitor with no session by the one address on the site
       * that never checks. The fallback below then answers instead, which is
       * the same thing that happens for a page the board has removed.
       */
      if (named !== null && named.status === "PUBLIC") {
        return PagesService.toSitePage(named);
      }
    }

    /*
     * Never the privacy notice. Its seeded sort order keeps it last only until
     * the board first drags the pages, which numbers every page afresh from
     * nought - the notice included - and a page created after that can tie
     * with it and lose the tie to the older row. Asking by slug holds for any
     * order the pages are in.
     */
    const row = await this.prisma.page.findFirst({
      where: {
        status: "PUBLIC",
        slug: { not: PRIVACY_NOTICE_SLUG },
        builtIn: null,
      },
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
      select: { slug: true, title: true, content: true, status: true },
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
      select: { slug: true, title: true, content: true, status: true },
    });

    if (row === null || row.status === "DRAFT") {
      return null;
    }
    if (row.status === "MEMBERS_ONLY" && !hasSession) {
      return null;
    }

    return PagesService.toSitePage(row);
  }

  /**
   * Writes a new association its ready-made website, once.
   *
   * Called when the setup wizard is completed, so a claimed instance answers
   * its own address with a site rather than with a 404, and the board starts
   * from pages to rewrite instead of an empty list. Five pages of its own - the
   * front page, About us, the board, the documents and the contact form - and
   * the menu, which names them in that order and the broker information page
   * after them. Every page is public and says, in the language the wizard was
   * finished in, what the board writes there. The privacy notice is seeded
   * beside it and stays as it is.
   *
   * It is idempotent in the blunt way: if the instance has any page of its own
   * it does nothing, so re-running the wizard from settings later cannot
   * produce a second front page or overwrite what the board has since written,
   * and an association that already has a site is given nothing. The check and
   * the writes are one transaction under the locks every writer of the page
   * order and the menu takes, so two completions at once cannot both find the
   * instance empty.
   *
   * The text is the cooperative's own legal-person facts - its name, its
   * organisation number - and placeholder prose. Nothing here reaches a
   * register: this file imports no register, no address book and no
   * decryption, which is what makes "the public website cannot publish personal
   * data" a property of the code rather than a promise. The board roster is a
   * block like any other, and what it names is decided where the blocks are
   * rendered.
   *
   * There is no banner on the front page: a banner is a picture the
   * association chose, described and with its consent recorded, and a new
   * association has none yet.
   */
  async seedDefaultPage(
    t: TFunction,
    association: { name: string; organizationNumber: string | null },
  ): Promise<{ created: boolean }> {
    const pages = this.seedPages(t, association);

    for (const { slug } of pages) {
      if (!isUsableSlug(slug)) {
        // A translated slug is still a URL. Refusing to write an unusable one
        // is better than writing a page that can never be opened.
        this.logger.error(
          `The seeded page's slug "${slug}" is not a usable address; no page was written.`,
        );
        return { created: false };
      }
    }

    const created = await this.prisma.$transaction(async (tx) => {
      await lockPageOrder(tx);
      await lockMenu(tx);

      // The privacy notice does not count. It is seeded by the same act of
      // claiming an instance, so counting it would make whether this writes a
      // front page depend on which of the two ran first. Nor do the built-in
      // pages, which every instance has from its first migration.
      const existing = await tx.page.count({
        where: { slug: { not: PRIVACY_NOTICE_SLUG }, builtIn: null },
      });
      if (existing > 0) {
        return false;
      }

      // After whatever the menu already holds, which on an instance with no
      // page of its own is at most an address elsewhere.
      const last = await tx.menuItem.findFirst({
        where: { parentId: null },
        orderBy: { sortOrder: "desc" },
        select: { sortOrder: true },
      });
      let place = (last?.sortOrder ?? -1) + 1;

      const now = new Date();
      for (const [index, seed] of pages.entries()) {
        await tx.page.create({
          data: {
            slug: seed.slug,
            title: seed.title,
            // Cast because Prisma types a JSON column with its own recursive
            // InputJsonValue, which a declared object type does not satisfy.
            content: seed.content as unknown as Prisma.InputJsonObject,
            status: "PUBLIC",
            publishedAt: now,
            // Published from the first moment, so its address is settled.
            slugFollowsTitle: false,
            // The front page is chosen, so the root serves it whatever the
            // board later does to the menu.
            frontPage: index === 0,
            sortOrder: index,
            /*
             * And its menu entry.
             *
             * Written with the page rather than after it, so a claimed
             * instance cannot end up with a page and no menu. An instance that
             * came with pages from before there was a menu got the same
             * arrangement from the menu migration's backfill, and its front
             * page from the migration that made the choice explicit. A fresh
             * cooperative and an old one therefore start from the same place.
             */
            menuItems: {
              create: { label: seed.title, kind: "PAGE", sortOrder: place },
            },
          },
        });
        place += 1;
      }

      // The broker information page is a row every instance has from its first
      // migration, so it is put in the menu rather than written. An entry the
      // board already made for it is left as it is.
      const broker = await tx.page.findUnique({
        where: { builtIn: "BROKER_INFORMATION" },
        select: { id: true, menuItems: { select: { id: true }, take: 1 } },
      });
      if (broker !== null && broker.menuItems.length === 0) {
        await tx.menuItem.create({
          data: {
            label: t(BUILT_IN_PAGE_TITLES.BROKER_INFORMATION),
            kind: "PAGE",
            pageId: broker.id,
            sortOrder: place,
          },
        });
      }

      return true;
    });

    if (created) {
      this.logger.log(
        `Wrote the association's first pages, from /${pages[0]?.slug ?? ""}`,
      );
    }
    return { created };
  }

  /**
   * The pages a new association starts with, in the order its menu names them.
   *
   * Each says what the board writes there, then carries the block that shows
   * what the instance already holds. The first is the front page.
   */
  private seedPages(
    t: TFunction,
    association: { name: string; organizationNumber: string | null },
  ): {
    slug: string;
    title: string;
    content: PageContent;
  }[] {
    const organizationNumber = association.organizationNumber?.trim() ?? "";
    const welcome = [
      t("site.seed.home.body", { association: association.name }),
      organizationNumber === ""
        ? ""
        : t("site.orgNumberLabel", { number: organizationNumber }),
    ];
    const page = (
      key: "about" | "board" | "documents" | "contact",
      ...blocks: PageBlock[]
    ) => {
      const text = paragraphsContent([t(`site.seed.${key}.body`)]);
      return {
        slug: t(`site.seed.${key}.slug`),
        title: t(`site.seed.${key}.title`),
        content: { ...text, blocks: [...text.blocks, ...blocks] },
      };
    };

    return [
      {
        slug: t("site.seed.home.slug"),
        // A greeting, not the cooperative's name: the name is already the
        // header of every page and the second half of every document title,
        // and a front page that says it three times reads like a placeholder.
        title: t("site.seed.home.title"),
        content: paragraphsContent(welcome),
      },
      page("about"),
      page("board", { type: "boardRoster" }),
      page("documents", { type: "documentList" }),
      page("contact", { type: "contactForm" }),
    ];
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
   * own not-found document. It is written with a high sort order so it sits
   * last in the board's list, and it is never chosen as the front page.
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
        status: "PUBLIC",
        publishedAt: new Date(),
        slugFollowsTitle: false,
        // Last among the association's own pages.
        sortOrder: PRIVACY_NOTICE_SORT_ORDER,
      },
    });

    this.logger.log(
      `Wrote the association's privacy notice at /${PRIVACY_NOTICE_SLUG}`,
    );
    return { created: true };
  }

  /**
   * Titles the built-in pages in the association's language.
   *
   * The migration that wrote them titled them in the language the association
   * had chosen, and in Swedish on an instance nobody had claimed yet - so the
   * setup wizard, which is where that choice is made, titles them again.
   *
   * Only a page nobody has saved since it was written. A title is the board's
   * to change, because it is what a menu entry for the page borrows, and
   * running the wizard again from settings must not undo a name the board gave
   * one. The revision says whether anybody has: it moves on every save.
   */
  async titleBuiltInPages(t: TFunction): Promise<void> {
    for (const builtIn of BUILT_IN_PAGES) {
      await this.prisma.page.updateMany({
        where: { builtIn, revision: 1 },
        data: { title: t(BUILT_IN_PAGE_TITLES[builtIn]) },
      });
    }
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
      select: { status: true },
    });
    return row !== null && row.status === "PUBLIC"
      ? `/${PRIVACY_NOTICE_SLUG}`
      : null;
  }

  private static toSitePage(row: {
    slug: string;
    title: string;
    content: unknown;
    status: PageStatus;
  }): SitePage {
    return {
      slug: row.slug,
      title: row.title,
      content: readPageContent(row.content),
      publiclyReadable: row.status === "PUBLIC",
    };
  }
}

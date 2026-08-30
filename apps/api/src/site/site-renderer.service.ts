import { Injectable } from "@nestjs/common";

import { PrincipalService } from "../authorization/principal.service";
import { BoardRosterService } from "../board/board-roster.service";
import { PrismaService } from "../database/prisma.service";
import {
  type DocumentView,
  DocumentsService,
} from "../documents/documents.service";
import { I18nService } from "../i18n/i18n.service";
import { IssueTypeService } from "../issues/issue-type.service";
import { mediaUrl } from "../media/media.service";
import { ThemeService } from "../themes/theme.service";
import { AssociationFactsService } from "./association-facts.service";
import { MenuService } from "./menu.service";
import { hasBlock } from "./page-content";
import { renderBrokerPage } from "./site-broker";
import { buildSiteStylesheet } from "./site-css";
import type { BrokerPageInput } from "./site-facts";
import type { SiteFormKind, SiteFormState, SiteIssueType } from "./site-forms";
import {
  type NewsTeaser,
  renderNotFound,
  renderPage,
  type SiteChrome,
  type SiteDocument,
} from "./site-html";
import { renderNewsArticle, renderNewsIndex } from "./site-news";
import { type SiteNewsArticle, SiteNewsService } from "./site-news.service";
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
 * `form-action 'self'` is the one addition the public forms needed, and it
 * narrows the policy rather than widening it: `default-src 'none'` does not
 * cover where a form submits to, so without this entry a page could post
 * somewhere else entirely. With it, a form on this website can only ever send
 * what somebody typed back to this instance - which is the promise the contact
 * form and the report form are making to the person filling them in.
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
    "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; font-src 'self'; form-action 'self'",
  "cache-control": "no-cache",
  vary: "cookie",
};

/** What the visitor has just done on the page being rendered, if anything. */
export interface SiteSubmissionState {
  sent?: SiteFormKind | null;
  refused?: SiteFormKind | null;
}

/**
 * One visit to a page: who is asking, and what they have just done.
 *
 * Two facts about the request rather than about the page, travelling together
 * because they are one thing to the caller. `hasSession` carries no default on
 * purpose: the menu differs by it, so a caller that had not thought about which
 * menu it was asking for would silently be given the anonymous one.
 */
export interface SiteVisit extends SiteSubmissionState {
  hasSession: boolean;
  /**
   * Who is asking, when a session says so.
   *
   * Read for one thing only: a document list block, where "signed in" is not
   * the question the archive answers. A page kept for the members is readable
   * by anyone signed in, deliberately, but the archive's shelves are narrower -
   * a resident who is not a member sees the public one, because the minutes and
   * the annual report are the members'. Answering that needs the person and not
   * a boolean.
   *
   * Nothing else reads it, and nothing else may: the menu, the news teasers and
   * the page itself are decided by hasSession, so a change here cannot widen
   * what any of those disclose.
   */
  personId: string | null;
}

@Injectable()
export class SiteRenderer {
  constructor(
    private readonly prisma: PrismaService,
    private readonly themes: ThemeService,
    private readonly i18n: I18nService,
    private readonly pages: PagesService,
    private readonly menu: MenuService,
    private readonly issueTypes: IssueTypeService,
    private readonly news: SiteNewsService,
    private readonly facts: AssociationFactsService,
    private readonly documents: DocumentsService,
    private readonly roster: BoardRosterService,
    private readonly principals: PrincipalService,
  ) {}

  /**
   * One page as a whole document.
   *
   * The visit is what this request is, and it reaches four different parts of
   * the answer. The session decides the menu: a member sees the entries for
   * the pages a member may open. It decides a news teaser block on the page as
   * well: a member sees the members' items among the public ones. Who the
   * session belongs to decides a document list, where "signed in" is not the
   * question the archive answers - it is asked per person, because a resident
   * who is not a member reads the public shelf. And what was just submitted
   * decides whether a form on the page shows a confirmation instead of itself -
   * it comes from the query string the submit endpoint redirected to, which is
   * what makes the confirmation a state of the page rather than a second
   * document, and what keeps the whole exchange to plain HTML.
   *
   * None of them decides the page. That was settled by the caller, which is
   * the one place that may settle it.
   *
   * One answer about the session serves all of them. Reading it twice would be
   * two places for the same request to reach two conclusions about who is
   * asking.
   */
  async page(
    acceptLanguage: string | undefined,
    page: SitePage,
    visit: SiteVisit,
  ): Promise<string> {
    const [chrome, forms] = await Promise.all([
      this.chrome(acceptLanguage, visit.hasSession),
      this.formState(page, visit),
    ]);
    return renderPage(
      await this.withBlockData(chrome, page, visit),
      page,
      forms,
    );
  }

  /**
   * What the forms on one page need to know about this request.
   *
   * The issue types are read only when the page actually carries the report
   * form, so an ordinary page costs no extra query. Null means the association
   * has public reporting switched off, and the block then renders as nothing -
   * the page survives the switch being turned, which is what lets a board close
   * the form without editing the page it sits on.
   */
  private async formState(
    page: SitePage,
    submission: SiteSubmissionState,
  ): Promise<SiteFormState> {
    const offersIssueForm =
      page.publiclyReadable && hasBlock(page.content, "issueReportForm");

    return {
      pagePath: `/${page.slug}`,
      publiclyReadable: page.publiclyReadable,
      sent: submission.sent ?? null,
      refused: submission.refused ?? null,
      issueTypes: offersIssueForm ? await this.publicIssueTypes() : null,
    };
  }

  /** The types a public report may be filed under, or null while it is shut. */
  private async publicIssueTypes(): Promise<readonly SiteIssueType[] | null> {
    if (!(await this.issueTypes.publicReportingEnabled())) {
      return null;
    }
    const types = await this.issueTypes.listReportable(null);
    return types.map((type) => ({ id: type.id, name: type.name }));
  }

  /**
   * The news index as a whole document.
   *
   * Session-aware for the chrome around it, exactly as a page is. Which items
   * the index lists was already decided by the caller; what the session
   * decides here is the menu, and a member who reaches the news through the
   * menu would otherwise lose it on arrival.
   *
   * It takes the same visit a page takes rather than a shape of its own, so
   * there is one answer in the renderer to who is asking. A news document
   * carries no form, so the submission half of the visit is not read here.
   */
  async newsIndex(
    acceptLanguage: string | undefined,
    items: readonly SiteNewsArticle[],
    visit: SiteVisit,
  ): Promise<string> {
    return renderNewsIndex(
      await this.chrome(acceptLanguage, visit.hasSession),
      items,
    );
  }

  /** One news item as a whole document, with the chrome this reader gets. */
  async newsArticle(
    acceptLanguage: string | undefined,
    article: SiteNewsArticle,
    visit: SiteVisit,
  ): Promise<string> {
    return renderNewsArticle(
      await this.chrome(acceptLanguage, visit.hasSession),
      article,
    );
  }

  /**
   * The website's own not-found document, in the visitor's language.
   *
   * Built from the chrome alone, never from anything a reader asked for, and
   * always with the menu an anonymous visitor gets. Every refusal the website
   * makes is this document, so what it holds must not vary with the address
   * that produced it, with what the association happens to have published, or
   * with who is asking: a member-only page, a member-only news item and an
   * address that names nothing have to answer identically, and the menu is the
   * only part of the chrome that could have differed between them. It is also
   * the one place where showing less costs nothing - somebody who mistyped an
   * address gets the public menu and can find their way from it.
   */
  async notFound(acceptLanguage: string | undefined): Promise<string> {
    return renderNotFound(await this.chrome(acceptLanguage, false));
  }

  /**
   * The chrome with whatever the blocks on this page need read for them.
   *
   * Every one of these is read only when the page actually carries the block
   * that shows it, so an ordinary page still costs the queries the chrome
   * itself needs and no more. That is the rule the news teaser established and
   * the reason it is worth keeping: a housing cooperative's front page is the
   * one address that has to answer quickly for somebody with no account.
   *
   * The four reads are independent and run together. Each is resolved for this
   * reader rather than for the page, which is what lets one stored page read
   * correctly for a visitor and for a member without the page knowing who
   * either of them is.
   */
  private async withBlockData(
    chrome: SiteChrome,
    page: SitePage,
    visit: SiteVisit,
  ): Promise<SiteChrome> {
    const [newsTeasers, documents, roster, facts] = await Promise.all([
      this.teasersFor(page, visit.hasSession),
      hasBlock(page.content, "documentList")
        ? this.documentsFor(visit.personId)
        : [],
      hasBlock(page.content, "boardRoster") ? this.roster.published() : [],
      hasBlock(page.content, "associationFacts")
        ? this.associationFacts()
        : null,
    ]);

    return { ...chrome, newsTeasers, documents, roster, facts };
  }

  /**
   * The news a teaser block on this page would show.
   *
   * Read for this reader, so a member sees the members' items among the public
   * ones. The largest count any block on the page asks for is what is fetched:
   * several teasers on one page are then one query, and each shows as many
   * items as it asked for.
   */
  private async teasersFor(
    page: SitePage,
    hasSession: boolean,
  ): Promise<readonly NewsTeaser[]> {
    const wanted = page.content.blocks.reduce(
      (most, block) =>
        block.type === "newsTeaser" ? Math.max(most, block.count) : most,
      0,
    );
    return wanted === 0 ? [] : this.news.teasers(hasSession, wanted);
  }

  /**
   * The documents a list block may show this reader.
   *
   * The archive decides, and it is asked with the reader's own principal rather
   * than with the boolean the rest of the website runs on: who may read a
   * document is a property of the document, and the archive's audiences do not
   * line up with "signed in". A resident who is not a member is offered the
   * public shelf, because the minutes and the annual report belong to the
   * members - that distinction is the archive's, expressed once in
   * audiencesFor, and reading it again here in a different shape would be the
   * second place able to get it wrong.
   *
   * Then one narrowing of the archive's answer, and it is this module's own:
   * the board's shelf is never listed on the website. A BOARD document's file
   * is served under a capability and every serve of one is written to the audit
   * log, while the website is the one surface in the product with no capability
   * check at all - so a link to one on a published page would be an invitation
   * nobody reading the page can act on, and a hint about what the board holds.
   * The board reads its own shelf in the archive, where it is signed in as the
   * board.
   *
   * Written as the two audiences that may be listed rather than as the one that
   * may not, so a fourth audience added to the schema later is left off the
   * website until somebody decides it belongs there.
   */
  private async documentsFor(
    personId: string | null,
  ): Promise<readonly SiteDocument[]> {
    const viewer =
      personId === null ? null : await this.principals.forPerson(personId);
    const documents = await this.documents.list(viewer);

    return documents
      .filter(
        (document) =>
          document.audience === "PUBLIC" || document.audience === "MEMBER",
      )
      .map((document) => toSiteDocument(document));
  }

  /**
   * The association's own facts, as both the broker page and a facts block
   * render them.
   *
   * Null only when the instance holds no association row at all. Three reads,
   * and the select lists are the boundary exactly as in chrome() below: the
   * name and the organisation number are the cooperative's own legal-person
   * facts, the recorded facts are what the board typed, and the apartment count
   * is a count. Nothing per-apartment and nothing per-person is selected.
   */
  private async associationFacts(): Promise<BrokerPageInput | null> {
    const [association, facts, apartmentCount] = await Promise.all([
      this.prisma.association.findUnique({
        where: { id: 1 },
        select: { organizationNumber: true },
      }),
      this.facts.read(),
      /*
       * How many apartments the association has: a count, and the only value
       * here derived from data the website does not own. It is a fact about the
       * association - printed in its annual report, asked for by every broker -
       * while the register is the list, and no part of the list crosses this
       * line. A query that selected rows rather than counted them would be the
       * first step over it.
       */
      this.prisma.apartment.count(),
    ]);

    return association === null
      ? null
      : {
          organizationNumber: association.organizationNumber,
          apartmentCount,
          facts,
        };
  }

  /**
   * The broker information page, or nothing at all.
   *
   * Nothing only when the instance holds no association row at all - a wizard
   * that has not reached its first step - and the caller answers that with the
   * website's own not-found document. It refuses an unclaimed instance a step
   * earlier, for the same reason.
   *
   * A claimed instance always has this page, even before its board has recorded
   * a single fact: it then carries the association's name and its organisation
   * number, which is more than a broker gets from a 404, and it does not make
   * the address start existing halfway through the board's first session.
   *
   * The page is public whoever asks - there is no member-only variant of it -
   * but the visit is still an argument, because the menu around it is the same
   * chrome every other page carries: a member reading the broker page is shown
   * the entries a member may open, exactly as on the front page. What stands
   * on the page itself does not depend on it, and the page carries no form, so
   * the session is the only part of the visit this answer reads.
   *
   * The reads and the select lists that bound them are in associationFacts()
   * above, which is also what a facts block on a page the board wrote is
   * rendered from: one account of the association, not two that can drift.
   */
  async broker(
    acceptLanguage: string | undefined,
    visit: SiteVisit,
  ): Promise<string | null> {
    const [chrome, input] = await Promise.all([
      // The association's own language, not the visitor's. The facts are stored
      // as the board wrote them and are never translated, so the labels around
      // them are rendered in the language the answers are already in.
      this.chrome(acceptLanguage, visit.hasSession, "association"),
      this.associationFacts(),
    ]);

    return input === null ? null : renderBrokerPage(chrome, input);
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
   *
   * Whose language it is rendered in is the caller's to say. A page the board
   * wrote is answered in the visitor's, because a cooperative that keeps an
   * English page and a Swedish one should serve each reader the one they asked
   * for. A generated page is answered in the association's own, because its
   * labels sit beside stored text that is never translated. The menu is the
   * board's own words either way, so it reads the same in both.
   */
  private async chrome(
    acceptLanguage: string | undefined,
    hasSession: boolean,
    language: "visitor" | "association" = "visitor",
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

    const locale =
      language === "association"
        ? this.i18n.resolveLocale(association?.defaultLocale)
        : visitorLocale(acceptLanguage, association?.defaultLocale);

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
      // Filled in by withBlockData for a page that carries the block each one
      // belongs to. Empty everywhere else, the news documents and the not-found
      // document included: the refusal a visitor gets for a member-only address
      // must not vary with what the association happens to have published.
      newsTeasers: [],
      documents: [],
      roster: [],
      facts: null,
      css: buildSiteStylesheet({
        rendering,
        primaryColor: association?.primaryColor ?? null,
      }),
    };
  }
}

/**
 * One archived document, narrowed to what a public page may say about it.
 *
 * The audience it was filed under and the row's own identifier are dropped
 * here rather than carried and then not rendered: the renderer is handed a
 * shape with nowhere to put either, so neither can reach the markup by a
 * mistake in a template.
 */
function toSiteDocument(document: DocumentView): SiteDocument {
  return {
    title: document.title,
    category: document.category,
    url: document.url,
    fileName: document.fileName,
    byteSize: document.byteSize,
  };
}

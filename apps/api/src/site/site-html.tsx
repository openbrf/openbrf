import type { TFunction } from "i18next";
import { Fragment, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  type BoardRosterEntry,
  POSITION_LABEL_KEYS,
} from "../board/board-roster";
import { APP_BASE_PATH } from "../http/app-base-path";
import type { SiteMenu, SiteMenuLink } from "./menu.service";
import type {
  DocumentListBlock,
  FaqBlock,
  PageBlock,
  TextRun,
} from "./page-content";
import type { SitePage } from "./pages.service";
import {
  type CalendarMonth,
  CALENDAR_MONTH_PARAM,
  formatCalendarMonth,
  type SiteEventDate,
} from "./site-events.service";
import {
  associationFactGroups,
  type BrokerPageInput,
  hasRecordedFacts,
  renderFactGroups,
} from "./site-facts";
import { renderSiteForm, type SiteFormState } from "./site-forms";

/**
 * The association's public website, as HTML.
 *
 * A pure module in the shape the mail templates use: it is handed everything it
 * needs and reads nothing - no database, no request, no environment. That makes
 * what the website can possibly contain a question about this file's arguments
 * rather than about the whole application, and the arguments carry the
 * cooperative's own name, its own writing and a stylesheet.
 *
 * Three properties are not negotiable and each is asserted by a test:
 *
 *   No script. Not an inline one, not a src, not an event handler attribute.
 *   The site is readable with JavaScript switched off because that is the
 *   honest way to publish a housing cooperative's notice board, and because a
 *   page with no script cannot be made to do anything on a visitor's behalf.
 *
 *   No third-party address. Every URL on the page resolves to this instance:
 *   the stylesheet is inline, the fonts are ours, the logo is streamed from the
 *   media route. A visitor's IP address is disclosed to nobody by reading the
 *   page.
 *
 *   No personal data except the board roster, and that only by consent. This
 *   module imports nothing from the registers, the address book or the
 *   encryption layer, so there is no path by which a resident's contact
 *   details, apartment or personal identity number could reach it. The one
 *   exception is a name and an elected position on the published board roster,
 *   which arrives already decided: who may be named is settled in
 *   src/board/board-roster.ts against each person's own publication consent,
 *   and a person with protected personal data is never in the list this module
 *   is handed. Nothing here filters it, exactly as nothing here filters the
 *   menu - a name that may not be published is absent rather than hidden.
 */

export interface SiteChrome {
  t: TFunction;
  locale: string;
  associationName: string;
  /** Same-origin media URL for the association's logo, or null. */
  logoUrl: string | null;
  /** The whole stylesheet, inlined into the document. */
  css: string;
  /**
   * Where a stored file is served from, given its id.
   *
   * Handed in rather than imported, so this module keeps reading nothing: what
   * a picture's address can possibly be stays a question about the caller, and
   * the caller is the one place that knows the media route.
   */
  mediaUrl: (mediaFileId: string) => string;
  /**
   * The path of the association's privacy notice, when it has a published
   * public one. Null leaves the link out rather than printing one that would
   * answer with the not-found page.
   */
  privacyNoticePath: string | null;
  /**
   * The menu, already narrowed to what this visitor may open.
   *
   * Narrowed by the caller rather than filtered here, and that is the whole
   * of the guarantee: this module is handed a list of links and prints it, so
   * there is no branch in the rendering that could show an entry to the wrong
   * reader. An anonymous visitor's menu simply does not contain the
   * member-only page, which is what stops the navigation telling them it
   * exists.
   */
  menu: SiteMenu;
  /**
   * The most recent news this reader may see, newest first.
   *
   * Resolved against the reader's own session by the caller and handed in like
   * everything else here, so a page carrying a news teaser shows a visitor with
   * no account the public items and a member theirs as well. Empty on every
   * page that carries no teaser, and empty on the not-found document always:
   * the refusal a visitor gets for a member-only address must not vary with
   * what the association happens to have published.
   */
  newsTeasers: readonly NewsTeaser[];
  /**
   * The next dates in the association's calendar this reader may see.
   *
   * Resolved against the reader's own session by the caller, like the news
   * teasers beside it, so a page carrying a calendar block shows a visitor with
   * no account the events published to the street and a member the members'
   * ones as well. Empty on every page that carries no calendar block, and empty
   * on the not-found document always.
   *
   * Carries a count of the places taken and no name. Who has signed up is
   * personal data behind events:manage, and the shape handed in here has
   * nowhere to put one.
   */
  eventDates: readonly SiteEventDate[];
  /**
   * The documents this reader may fetch, in the archive's own order.
   *
   * Narrowed by the caller against the reader's own account, exactly as the
   * menu and the news teasers are, so there is no branch here that could list
   * a shelf to the wrong person. A visitor with no session is handed the
   * public shelf; a member is handed theirs as well. Empty on every page that
   * carries no document list, and on the not-found document always.
   *
   * Deliberately not the archive's own row shape: there is no audience on
   * these and no identifier, so neither can reach the markup.
   */
  documents: readonly SiteDocument[];
  /**
   * The board, as the association publishes it. Already decided.
   *
   * Every name in this list has a standing publication consent for the board
   * roster scope, and nobody in it carries protected personal data. That is
   * settled in src/board, before the list is built, which is what makes the
   * absence of a filter here a property rather than an oversight.
   */
  roster: readonly BoardRosterEntry[];
  /**
   * The association's recorded facts, for a page that carries a facts block.
   *
   * Null on every other page, so an ordinary page costs no query and the block
   * renders as nothing where nothing was read.
   */
  facts: BrokerPageInput | null;
}

/**
 * One document as the website lists it.
 *
 * A title, where it is fetched from, and enough about the file that a person
 * on a telephone knows what they are about to download. Not the archive's
 * DocumentView: that carries the audience the document was filed under and the
 * row's own identifier, and neither has any business on a published page.
 */
export interface SiteDocument {
  /** What the board called it, in the language the board wrote it in. */
  title: string;
  /** The binder it is filed in, which is what a list groups by. */
  category: string;
  /** A path on this instance, served by the media route. */
  url: string;
  fileName: string;
  byteSize: number;
}

/** One news item as a teaser shows it. */
export interface NewsTeaser {
  /** The path segment under /nyheter. */
  slug: string;
  title: string;
  /** When it was published. Rendered as a calendar date, never a clock time. */
  publishedAt: Date;
  /** The opening of the body, as much of it as a teaser shows. */
  teaser: string;
}

/** Where the association's news lives, and the prefix every article sits under. */
export const NEWS_PATH = "/nyheter";

/** The address of one news item. */
export function newsPath(slug: string): string {
  return `${NEWS_PATH}/${slug}`;
}

/**
 * Where the association's calendar lives, and the prefix an event sits under.
 *
 * One address for the calendar and one per event, and nothing per date. A
 * reader arriving at a cleaning day in April wants the series - what to bring,
 * and when the other cleaning days are - so the address is the series' and the
 * occurrences are what stands on it.
 */
export const CALENDAR_PATH = "/kalender";

/** The address of one event. */
export function eventPath(eventId: string): string {
  return `${CALENDAR_PATH}/${eventId}`;
}

/**
 * The address of one month of the calendar.
 *
 * A query parameter rather than a path segment, so /kalender is always the
 * calendar and a month is a view of it. There is no script on the website, so
 * this is what a prev or next anchor is: an ordinary link the browser follows.
 */
export function calendarMonthPath(month: CalendarMonth): string {
  return `${CALENDAR_PATH}?${CALENDAR_MONTH_PARAM}=${formatCalendarMonth(month)}`;
}

/**
 * The calendar a published date is read against.
 *
 * The association is in Sweden and its notices are dated the way the people
 * reading them date things. Both halves of a published date derive from this
 * one zone, because a notice put up late on the last of the month must not be
 * shown as one day and marked up as another.
 */
const ASSOCIATION_TIME_ZONE = "Europe/Stockholm";

/**
 * A published date, as a calendar date in the reader's own language.
 *
 * The date and not the time. When a notice about the stairwell went up is
 * information a reader uses; the minute it went up is not, and printing it
 * would say more about the board's evening than about the notice.
 */
export function formatNewsDate(date: Date, locale: string): string {
  return new Intl.DateTimeFormat(locale, {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: ASSOCIATION_TIME_ZONE,
  }).format(date);
}

/**
 * The day an event falls on, with its weekday, in the reader's own language.
 *
 * The weekday is what a published date is missing and what a calendar needs: a
 * cleaning day is planned around by whether it is a Saturday, and a reader
 * looking at a list of dates should not have to work that out. A news item's
 * publication date carries no weekday for the same reason in reverse - when a
 * notice went up is read as a date and never as a day of the week.
 */
export function formatEventDate(date: Date, locale: string): string {
  return new Intl.DateTimeFormat(locale, {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: ASSOCIATION_TIME_ZONE,
  }).format(date);
}

/**
 * The time of day an event runs at, on the association's own wall clock.
 *
 * The 24-hour cycle is stated rather than left to the locale, because the
 * notice in the stairwell says 10:00 and a page that rendered it as 10 AM for
 * an English-reading visitor would be quoting the board differently from the
 * board.
 */
export function formatEventTime(date: Date, locale: string): string {
  return new Intl.DateTimeFormat(locale, {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone: ASSOCIATION_TIME_ZONE,
  }).format(date);
}

/**
 * A month, as the calendar's own heading names it.
 *
 * Built from noon rather than from midnight: the label is formatted in the
 * association's zone, and midnight UTC on the first of a month is the evening
 * before in Stockholm for part of the year - which would head April's page with
 * March.
 */
export function formatCalendarMonthName(
  month: CalendarMonth,
  locale: string,
): string {
  return new Intl.DateTimeFormat(locale, {
    year: "numeric",
    month: "long",
    timeZone: ASSOCIATION_TIME_ZONE,
  }).format(new Date(Date.UTC(month.year, month.month - 1, 1, 12)));
}

const DOCTYPE = "<!doctype html>";

/**
 * One page, rendered.
 *
 * The form state travels beside the page rather than inside it because it is
 * about this request: which form was just sent, and whether the association is
 * taking public reports at all. A page's body records that a form is here, and
 * nothing else about it.
 */
export function renderPage(
  chrome: SiteChrome,
  page: SitePage,
  forms: SiteFormState,
): string {
  return renderDocument(
    chrome,
    page.title,
    <>
      <h1 className="site-title">{page.title}</h1>
      {page.content.blocks.map((block, index) =>
        renderBlock(chrome, block, index, forms),
      )}
    </>,
  );
}

/**
 * The page a visitor gets for an address that has nothing behind it.
 *
 * Deterministic for a given locale, and that is the point rather than a
 * convenience: a member-only page is answered with exactly this, byte for byte,
 * so an anonymous visitor cannot tell an address that is closed to them from
 * one that was never written. The two must not diverge, which is why there is
 * one function and not two.
 */
export function renderNotFound(chrome: SiteChrome): string {
  return renderDocument(
    chrome,
    chrome.t("site.notFound.title"),
    <>
      <h1 className="site-title">{chrome.t("site.notFound.title")}</h1>
      <p>{chrome.t("site.notFound.body")}</p>
    </>,
  );
}

/**
 * A block becomes markup here, or it becomes nothing.
 *
 * The switch is exhaustive over the types this renderer knows, and an unknown
 * one returns null. That is what keeps a body written by a later editor from
 * reaching a browser through an older renderer: the page shows less, never
 * something this version cannot vouch for. Every string is a React child, so
 * React escapes it - a paragraph containing markup is shown as the characters
 * the board typed.
 *
 * The two attributes that are not text are the two a block cannot choose
 * freely: a link's address, which the parser has already limited to http,
 * https, mailto and a path on this instance, and a picture's, which is built
 * from a stored file's id and so cannot name another host at all.
 *
 * A null form state is a document that has no form to show - a news article,
 * whose body is prose and nothing else - and a form block reaching this
 * renderer there is shown as nothing rather than as a form posting to an
 * address that is not a page.
 */
export function renderBlock(
  chrome: SiteChrome,
  block: PageBlock,
  index: number,
  forms: SiteFormState | null,
): ReactElement | null {
  switch (block.type) {
    case "paragraph":
      return <p key={index}>{renderRuns(block.runs)}</p>;
    case "heading":
      return block.level === 2 ? (
        <h2 key={index}>{renderRuns(block.runs)}</h2>
      ) : (
        <h3 key={index}>{renderRuns(block.runs)}</h3>
      );
    case "image":
      return (
        <figure className="site-figure" key={index}>
          <img src={chrome.mediaUrl(block.mediaFileId)} alt={block.alt} />
          {block.caption === undefined ? null : (
            <figcaption>{block.caption}</figcaption>
          )}
        </figure>
      );
    case "contactForm":
    case "issueReportForm":
      // The markup is in site-forms.tsx, and the intro is rendered here: a
      // form's intro is text runs like any other prose on the page, so it goes
      // through the same renderer rather than through a second one that could
      // treat a link differently.
      return forms === null
        ? null
        : renderSiteForm(
            chrome.t,
            block,
            forms,
            block.intro === undefined ? null : <p>{renderRuns(block.intro)}</p>,
            index,
          );
    case "newsTeaser":
      return renderNewsTeaser(chrome, block.count, index);
    case "eventCalendar":
      return renderEventCalendar(chrome, block.count, index);
    case "documentList":
      return renderDocumentList(chrome, block, index);
    case "boardRoster":
      return renderBoardRoster(chrome, index);
    case "associationFacts":
      return renderAssociationFacts(chrome, index);
    case "faq":
      return renderFaq(chrome, block, index);
    default:
      return null;
  }
}

/**
 * The association's documents, on a page that asked for them.
 *
 * The list comes from the chrome, already narrowed to what this reader may
 * fetch, so the block itself decides only which binder to show. A block that
 * names a binder nothing is filed in renders as nothing, and so does one on an
 * instance whose archive holds nothing this reader may have: a page must not
 * announce a shelf that is empty for whoever is looking at it, and an empty
 * heading is also how a visitor would learn that the members have documents
 * they do not.
 *
 * A binder's own name is the board's word and is printed as written; the
 * heading over a list of everything is chrome and is translated.
 */
function renderDocumentList(
  chrome: SiteChrome,
  block: DocumentListBlock,
  index: number,
): ReactElement | null {
  const listed =
    block.category === undefined
      ? chrome.documents
      : chrome.documents.filter(
          (document) => document.category === block.category,
        );
  if (listed.length === 0) {
    return null;
  }

  return (
    <section className="site-documents" key={index}>
      <h2>{block.category ?? chrome.t("site.documents.heading")}</h2>
      {/*
       * Grouped by binder only when the block lists every one of them.
       * A list the board narrowed to "Protokoll" already says so in its
       * heading, and repeating the word over the one group would be the page
       * telling the reader the same thing twice.
       */}
      {block.category === undefined
        ? groupByCategory(listed).map((group) => (
            <Fragment key={group.category}>
              <h3>{group.category}</h3>
              {renderDocuments(chrome, group.documents)}
            </Fragment>
          ))
        : renderDocuments(chrome, listed)}
    </section>
  );
}

/** The binders in the order the archive returned them, each with its files. */
function groupByCategory(
  documents: readonly SiteDocument[],
): { category: string; documents: SiteDocument[] }[] {
  const groups: { category: string; documents: SiteDocument[] }[] = [];
  for (const document of documents) {
    const last = groups.at(-1);
    if (last !== undefined && last.category === document.category) {
      last.documents.push(document);
      continue;
    }
    groups.push({ category: document.category, documents: [document] });
  }
  return groups;
}

/**
 * One shelf, as links.
 *
 * The address is the media route's, built from the stored file's id by the
 * caller, so a document cannot name another host any more than a picture can.
 * The media route decides for itself whether it will serve the bytes: this
 * list is what the archive said the reader may see, and the file behind each
 * entry is served under the same decision rather than under this page's.
 *
 * The file's own name and size sit under the title because a document on a
 * housing cooperative's website is opened on a telephone, and knowing it is a
 * four megabyte scan before tapping it is the difference between a link and a
 * surprise.
 */
function renderDocuments(
  chrome: SiteChrome,
  documents: readonly SiteDocument[],
): ReactElement {
  return (
    <ul className="site-document-list">
      {documents.map((document) => (
        <li className="site-document" key={document.url}>
          <a href={document.url}>{document.title}</a>
          <p className="site-document-meta">
            {chrome.t("site.documents.file", {
              name: document.fileName,
              size: fileSize(document.byteSize, chrome),
            })}
          </p>
        </li>
      ))}
    </ul>
  );
}

/**
 * A file's size, as a person reads it.
 *
 * Decimal kilobytes and megabytes rather than the binary ones, because that is
 * what the file manager the reader downloaded it into will say, and a page that
 * disagrees with the operating system about the size of the same file reads as
 * wrong. The number is formatted for the reader's own language: a Swedish
 * reader is shown 1,2 MB and an English one 1.2 MB.
 */
function fileSize(bytes: number, chrome: SiteChrome): string {
  const kilobytes = bytes / 1000;
  if (kilobytes < 1000) {
    // Never zero. A file of a few hundred bytes exists, and "0 kB" reads as a
    // fault in the archive rather than as a small file.
    return chrome.t("site.documents.kilobytes", {
      size: format(chrome.locale, Math.max(1, Math.round(kilobytes)), 0),
    });
  }
  return chrome.t("site.documents.megabytes", {
    size: format(chrome.locale, kilobytes / 1000, 1),
  });
}

function format(locale: string, value: number, decimals: number): string {
  return new Intl.NumberFormat(locale, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(value);
}

/**
 * The board, on a page that publishes it.
 *
 * Every name here arrived with a standing publication consent for this scope,
 * and nobody with protected personal data is in the list at all. Neither is
 * decided here: this renders what it was handed, exactly as it prints the menu
 * it was handed, so there is no branch in the markup that could name the wrong
 * person.
 *
 * An empty roster renders as nothing rather than as a heading over nothing. An
 * association whose board has not been asked for its consents publishes no
 * roster, and a heading with no names under it would read as the board having
 * resigned.
 */
function renderBoardRoster(
  chrome: SiteChrome,
  index: number,
): ReactElement | null {
  if (chrome.roster.length === 0) {
    return null;
  }

  return (
    <section className="site-roster" key={index}>
      <h2>{chrome.t("site.roster.heading")}</h2>
      <ul className="site-roster-list">
        {chrome.roster.map((entry, at) => (
          <li className="site-roster-entry" key={at}>
            <span className="site-roster-name">{entry.name}</span>
            <span className="site-roster-position">
              {chrome.t(POSITION_LABEL_KEYS[entry.position])}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * The association's recorded facts, on a page the board arranged.
 *
 * The same rows the broker information page is made of, from the same builder.
 * The groups sit a level lower here because the block carries a heading of its
 * own and the page carries a title above that: the broker page's outline is
 * h1 then the groups, and a block's is h1, the block, then the groups.
 *
 * Nothing recorded renders as nothing. The broker page is the other way round -
 * it exists from the day the feature ships, because a broker was given its
 * address - but a block is put on a page by a board that means to publish
 * facts, and one that showed the association its own name back and nothing else
 * would read as a fault.
 */
function renderAssociationFacts(
  chrome: SiteChrome,
  index: number,
): ReactElement | null {
  const facts = chrome.facts;
  if (facts === null) {
    return null;
  }

  const groups = associationFactGroups(chrome, facts);
  if (!hasRecordedFacts(groups)) {
    return null;
  }

  return (
    <section className="site-facts-block" key={index}>
      <h2>{chrome.t("site.facts.heading")}</h2>
      {renderFactGroups(groups, 3)}
    </section>
  );
}

/**
 * The questions the association answers, and its answers.
 *
 * A description list, because that is what a question and its answer are: a
 * screen reader announces the pair, and the question is a label rather than a
 * heading for a section that does not exist. Not a disclosure widget either -
 * an answer folded away is an answer missing from a printed page and from the
 * reader's own search of it, and a housing cooperative's FAQ is short enough
 * to read.
 *
 * The heading is chrome and is translated; everything under it is the board's
 * own writing, escaped by being a React child like every other stored string.
 */
function renderFaq(
  chrome: SiteChrome,
  block: FaqBlock,
  index: number,
): ReactElement | null {
  if (block.items.length === 0) {
    return null;
  }

  return (
    <section className="site-faq" key={index}>
      <h2>{chrome.t("site.faq.heading")}</h2>
      <dl className="site-faq-list">
        {block.items.map((item, at) => (
          <div key={at}>
            <dt>{item.question}</dt>
            <dd>
              <p>{renderRuns(item.answer)}</p>
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

/**
 * The most recent news, on a page that asked for it.
 *
 * The items come from the chrome, already filtered to what this reader may
 * see, so the block itself decides only how many of them to show. A block on a
 * page of an instance that has published nothing renders as nothing at all
 * rather than as an empty heading: a page must not announce a news section the
 * association has not started writing.
 */
function renderNewsTeaser(
  chrome: SiteChrome,
  count: number,
  index: number,
): ReactElement | null {
  const items = chrome.newsTeasers.slice(0, count);
  if (items.length === 0) {
    return null;
  }

  return (
    <section className="site-news" key={index}>
      <h2>{chrome.t("news.site.heading")}</h2>
      <ul className="site-news-list">
        {items.map((item) => (
          <li className="site-news-item" key={item.slug}>
            <p className="site-news-date">
              <time dateTime={isoDate(item.publishedAt)}>
                {formatNewsDate(item.publishedAt, chrome.locale)}
              </time>
            </p>
            <h3>
              <a href={newsPath(item.slug)}>{item.title}</a>
            </h3>
            {item.teaser === "" ? null : <p>{item.teaser}</p>}
          </li>
        ))}
      </ul>
      <p>
        <a href={NEWS_PATH}>{chrome.t("news.site.allNews")}</a>
      </p>
    </section>
  );
}

/**
 * The association's next dates, on a page that asked for them.
 *
 * The dates come from the chrome, already narrowed to what this reader may see,
 * so the block itself decides only how many of them to show. A block on an
 * instance whose calendar holds nothing this reader may have renders as nothing
 * at all rather than as an empty heading - a page must not announce a calendar
 * the association has not started keeping, and an empty heading is also how a
 * visitor would learn that the members have dates they do not.
 */
function renderEventCalendar(
  chrome: SiteChrome,
  count: number,
  index: number,
): ReactElement | null {
  const dates = chrome.eventDates.slice(0, count);
  if (dates.length === 0) {
    return null;
  }

  return (
    <section className="site-calendar" key={index}>
      <h2>{chrome.t("site.calendar.heading")}</h2>
      {renderEventDates(chrome, dates)}
      <p>
        <a href={CALENDAR_PATH}>{chrome.t("site.calendar.wholeCalendar")}</a>
      </p>
    </section>
  );
}

/**
 * A list of dates, as both the calendar block and the calendar pages show them.
 *
 * Exported so the block on a page the board wrote, the month at /kalender and
 * one event's own page are one renderer and not three. A second copy would
 * drift, and the drift that matters is the called-off marker: a page whose
 * block showed a cancelled cleaning day as though it were going ahead would
 * send somebody down to the courtyard on a Saturday morning.
 *
 * Always third-level headings, because the three places that use it have the
 * same outline above them: the page or the calendar's title, then the heading
 * of the block or of the month, then the dates.
 *
 * Every date links to its own event rather than to itself. The occurrence has
 * no address, and it does not need one: what the reader is being sent to is the
 * series that says what to bring and when the others are.
 */
export function renderEventDates(
  chrome: SiteChrome,
  dates: readonly SiteEventDate[],
): ReactElement {
  const { t } = chrome;

  return (
    <ul className="site-calendar-list">
      {dates.map((date, at) => (
        <li className="site-calendar-item" key={at}>
          <p className="site-calendar-when">
            <time dateTime={isoDate(date.startsAt)}>
              {formatEventDate(date.startsAt, chrome.locale)}
            </time>{" "}
            {t("site.calendar.time", {
              from: formatEventTime(date.startsAt, chrome.locale),
              to: formatEventTime(date.endsAt, chrome.locale),
            })}
          </p>
          <h3>
            <a href={eventPath(date.eventId)}>{date.title}</a>
          </h3>
          {/*
           * Called off before anything else about the date, because it is what
           * changes what the reader should do with the rest of it. The date
           * stays on the page: the association announced it, and "the cleaning
           * day on the 18th is off" is a different thing to say than saying
           * nothing.
           */}
          {date.cancelled ? (
            <p className="site-calendar-cancelled">
              {t("site.calendar.cancelled")}
            </p>
          ) : null}
          {date.location === null ? null : (
            <p className="site-calendar-where">{date.location}</p>
          )}
          {renderPlaces(chrome, date)}
        </li>
      ))}
    </ul>
  );
}

/**
 * How many places at one date are gone.
 *
 * A count and never a name, which is the whole of what the website may say
 * about who is coming: the roll-call is personal data about the association's
 * own residents and it is behind events:manage. There is nothing on the shape
 * this reads from that a name could have travelled in.
 *
 * Nothing at all for a series that takes no sign-ups, and nothing for a date
 * the board has called off: a place at an event that is not happening is not a
 * thing to count. A series with no limit says how many have put their name down
 * and stops there - there is no number to be short of.
 */
function renderPlaces(
  chrome: SiteChrome,
  date: SiteEventDate,
): ReactElement | null {
  if (!date.signupOpen || date.cancelled) {
    return null;
  }
  const { t } = chrome;

  if (date.capacity === null) {
    return date.placesTaken === 0 ? null : (
      <p className="site-calendar-places">
        {t("site.calendar.signedUp", { taken: date.placesTaken })}
      </p>
    );
  }

  return (
    <p className="site-calendar-places">
      {date.placesTaken >= date.capacity
        ? t("site.calendar.full")
        : t("site.calendar.places", {
            taken: date.placesTaken,
            capacity: date.capacity,
          })}
    </p>
  );
}

/**
 * The machine-readable half of a published date, for the time element.
 *
 * The same calendar day the reader is shown, and not the UTC one: an item
 * published at half past midnight is dated by the day it went up here.
 */
export function isoDate(date: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone: ASSOCIATION_TIME_ZONE,
  }).formatToParts(date);
  const part = (type: string): string =>
    parts.find((one) => one.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

/**
 * The runs of one text block, in order.
 *
 * Marks nest here in a fixed order - a link outermost, then bold, then italic -
 * rather than in whatever order they were applied. The result is the same to
 * read and the same to a screen reader, and one order means one output for one
 * stored run, which is what lets the not-found page and every other rendering
 * be compared byte for byte.
 */
export function renderRuns(runs: readonly TextRun[]): ReactNode {
  return runs.map((run, index) => (
    <Fragment key={index}>{renderRun(run)}</Fragment>
  ));
}

function renderRun(run: TextRun): ReactNode {
  let node: ReactNode = run.text;
  if (run.italic === true) {
    node = <em>{node}</em>;
  }
  if (run.bold === true) {
    node = <strong>{node}</strong>;
  }
  if (run.link !== undefined) {
    /*
     * A link is the one external reference a page may carry, and it is a
     * navigation rather than a subresource: nothing is fetched from the other
     * host while the page is being read. What the visitor's browser must not
     * do is tell that host where they came from, so a link that leaves this
     * origin carries noreferrer beside noopener. A path on this instance and a
     * mailto: address need neither.
     */
    node = isExternal(run.link) ? (
      <a href={run.link} rel="noopener noreferrer">
        {node}
      </a>
    ) : (
      <a href={run.link}>{node}</a>
    );
  }
  return node;
}

function isExternal(url: string): boolean {
  return url.startsWith("http:") || url.startsWith("https:");
}

/**
 * The menu the board arranged, as markup.
 *
 * A list of links inside a nav, and that is deliberately all it is. There is
 * no script on the website, so the dropdown is done in the stylesheet: on a
 * narrow screen the second level simply sits under its parent, indented, and
 * on a wide one it is hidden and revealed by hover and by keyboard focus
 * moving into the group. Both shapes leave the parent an ordinary link, which
 * a control that is both a link and a disclosure cannot be - and a keyboard
 * reaches every item in either, because the reveal happens as focus lands on
 * the parent, before the next tab.
 *
 * Nothing is filtered here. The list arrives already narrowed to what this
 * visitor may open, so a member-only page is absent rather than hidden, and
 * the markup carries no trace of it.
 *
 * The nav has no name of its own because there is one on the page: an
 * accessible name exists to tell several navigations apart, and inventing a
 * word here would put chrome text on a page whose menu is the board's own.
 */
function renderMenu(menu: SiteMenu): ReactElement | null {
  if (menu.length === 0) {
    return null;
  }

  return (
    <nav className="site-nav">
      <ul>
        {menu.map((entry, index) => (
          <li
            className={
              entry.children.length === 0 ? undefined : "site-nav-group"
            }
            key={index}
          >
            {renderMenuLink(entry)}
            {entry.children.length === 0 ? null : (
              <ul className="site-nav-children">
                {entry.children.map((child, childIndex) => (
                  <li key={childIndex}>{renderMenuLink(child)}</li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ul>
    </nav>
  );
}

/**
 * One entry, as an anchor and nothing else.
 *
 * An external entry is a text anchor and never a picture or a stylesheet
 * reference: the promise that reading a page discloses a visitor's address to
 * nobody is about what the browser fetches, and a navigation the visitor
 * chooses to follow is the one external reference the website allows. It
 * carries noreferrer beside noopener for the same reason a link in a
 * paragraph does - the other host is not told where the reader came from.
 */
function renderMenuLink(link: SiteMenuLink): ReactElement {
  return link.external ? (
    <a href={link.href} rel="noopener noreferrer">
      {link.label}
    </a>
  ) : (
    <a href={link.href}>{link.label}</a>
  );
}

/**
 * One document, chrome and all.
 *
 * Exported so that everything the website answers with goes through this one
 * function: the pages, the news index, an article, the broker page, and the
 * refusal. A second
 * shell would be a second header and footer to keep in step, and the first time
 * they disagreed the difference would be visible from the outside.
 */
export function renderDocument(
  chrome: SiteChrome,
  title: string,
  main: ReactElement,
): string {
  const { t, locale, associationName, logoUrl, css } = chrome;

  const markup = renderToStaticMarkup(
    <html lang={locale}>
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{`${title} - ${associationName}`}</title>
        {/*
         * Raw rather than a text child: React escapes text, and an escaped
         * quotation mark inside a selector would silently break the theme. The
         * stylesheet has had every "<" removed before it reaches here, so it
         * cannot close this element or open another.
         */}
        {/* nosemgrep: typescript.react.security.audit.react-dangerouslysetinnerhtml.react-dangerouslysetinnerhtml */}
        <style dangerouslySetInnerHTML={{ __html: css }} />
      </head>
      <body>
        <div className="site">
          <header className="site-header">
            {logoUrl === null ? null : (
              <img className="site-logo" src={logoUrl} alt="" />
            )}
            <p className="site-name">{associationName}</p>
            {renderMenu(chrome.menu)}
          </header>
          <main className="site-main">{main}</main>
          <footer className="site-footer">
            {chrome.privacyNoticePath === null ? null : (
              <a href={chrome.privacyNoticePath}>
                {t("site.privacyNotice.link")}
              </a>
            )}
            <a href={APP_BASE_PATH}>{t("site.signIn")}</a>
          </footer>
        </div>
      </body>
    </html>,
  );

  return `${DOCTYPE}${markup}`;
}

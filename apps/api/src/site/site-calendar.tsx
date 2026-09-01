import type { ReactElement } from "react";

import {
  CALENDAR_PATH,
  calendarMonthPath,
  formatCalendarMonthName,
  renderDocument,
  renderEventDates,
  type SiteChrome,
} from "./site-html";
import type { SiteCalendarPage, SiteEvent } from "./site-events.service";

/**
 * The association's calendar, as HTML.
 *
 * The same pure module the rest of the website is: handed everything it needs,
 * reading nothing. It renders through the one document shell in site-html, so
 * the header, the footer and the stylesheet a calendar page carries are the same
 * ones a page carries - a second shell would be a second thing to keep in step,
 * and the first time they disagreed the difference would show on the street.
 *
 * The dates themselves are rendered by site-html's own renderEventDates, which
 * is also what a calendar block on a page the board wrote is drawn with. One
 * renderer for all three, because the part that must not drift is what a date
 * says: a called-off cleaning day shown as going ahead sends somebody down to
 * the courtyard on a Saturday morning.
 *
 * ## No script, and therefore no month picker
 *
 * Moving between months is two anchors. The website runs no JavaScript at all -
 * the content policy names no script source, so a browser would refuse one -
 * and a calendar is the kind of thing that invites a grid somebody drags
 * around. A month is a query parameter, prev and next are ordinary links, and
 * the reader's own back button works. Which month somebody is looking at lives
 * in the address bar, because the website sets no cookie and keeps no session.
 *
 * ## There is no refusal in this file
 *
 * An event somebody may not read is answered by the caller with the website's
 * own not-found document, byte for byte the same one an address with nothing
 * behind it gets. That is the only refusal the website has, and it is why
 * nothing here has to decide who is asking.
 */

/** One month of the calendar: what falls in it, and the way out either side. */
export function renderCalendarPage(
  chrome: SiteChrome,
  page: SiteCalendarPage,
): string {
  const { t } = chrome;

  return renderDocument(
    chrome,
    t("site.calendar.title"),
    <>
      <h1 className="site-title">{t("site.calendar.title")}</h1>
      <h2 className="site-calendar-month">
        {formatCalendarMonthName(page.month, chrome.locale)}
      </h2>
      {/*
       * A neighbour the calendar does not reach is no anchor at all rather than
       * a disabled one: there is no script to disable anything with, and a link
       * that answered with the same month it was followed from would read as a
       * fault in the page.
       */}
      <nav className="site-calendar-nav">
        {page.previous === null ? null : (
          <a href={calendarMonthPath(page.previous)} rel="prev">
            {t("site.calendar.previousMonth")}
          </a>
        )}
        {page.next === null ? null : (
          <a href={calendarMonthPath(page.next)} rel="next">
            {t("site.calendar.nextMonth")}
          </a>
        )}
      </nav>
      {page.dates.length === 0 ? (
        <p>{t("site.calendar.emptyMonth")}</p>
      ) : (
        renderEventDates(chrome, page.dates)
      )}
    </>,
  );
}

/** One event: what it is, and every date it falls on. */
export function renderEventPage(chrome: SiteChrome, event: SiteEvent): string {
  const { t } = chrome;

  return renderDocument(
    chrome,
    event.title,
    <>
      <h1 className="site-title">{event.title}</h1>
      {event.category === null ? null : (
        <p className="site-event-category">{event.category}</p>
      )}
      {renderDescription(event.description)}
      {/*
       * Where it happens is not repeated here. It stands on every date below,
       * which is where a reader looking for it is looking, and a series whose
       * board moved the location between two of its dates would otherwise
       * contradict itself at the top of its own page.
       */}
      {event.dates.length === 0 ? null : (
        <>
          <h2>{t("site.calendar.datesHeading")}</h2>
          {renderEventDates(chrome, event.dates)}
        </>
      )}
      {/*
       * How to sign up, for a series that takes sign-ups. The website takes no
       * authenticated writes at all - it sets no cookie and posts nothing but
       * the two public forms - so the answer is the application, which the
       * footer of every page already links to.
       */}
      {event.dates.some((date) => date.signupOpen) ? (
        <p>{t("site.calendar.signupNote")}</p>
      ) : null}
      <p>
        <a href={CALENDAR_PATH}>{t("site.calendar.wholeCalendar")}</a>
      </p>
    </>,
  );
}

/**
 * What the board wrote about the event, as paragraphs.
 *
 * Plain text on the row rather than the block list a page and a news item
 * carry, so the one piece of structure it can hold is where the board pressed
 * return. Split on that and printed as paragraphs: a description of what to
 * bring, written as three lines, reads as three lines. Every string is a React
 * child, so what reaches the browser is the characters the board typed.
 */
function renderDescription(description: string | null): ReactElement | null {
  if (description === null) {
    return null;
  }
  const lines = description
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
  if (lines.length === 0) {
    return null;
  }

  return (
    <>
      {lines.map((line, at) => (
        <p key={at}>{line}</p>
      ))}
    </>
  );
}

import { beforeAll, describe, expect, it } from "vitest";

import { I18nService } from "../i18n/i18n.service";
import { readPageContent } from "./page-content";
import type { SitePage } from "./pages.service";
import { renderCalendarPage, renderEventPage } from "./site-calendar";
import {
  calendarMonthOf,
  clampCalendarMonth,
  formatCalendarMonth,
  parseCalendarMonth,
  shiftCalendarMonth,
  type SiteEvent,
  type SiteEventDate,
} from "./site-events.service";
import type { SiteFormState } from "./site-forms";
import { renderPage, type SiteChrome } from "./site-html";

/**
 * The association's calendar, on its own website.
 *
 * What is asserted here is what the rendering and the month arithmetic do. Who
 * may see which dates is not: the filtering is the service's, a members-only
 * event never reaches this file for somebody with no session, and the refusal is
 * the same not-found document a missing address produces. That half is held by
 * site-calendar.int-spec.ts, against a real database and the real routing.
 *
 * Two properties in here are the ones worth breaking the implementation to
 * check. A date the board has called off must say so wherever it appears, on the
 * calendar page and in a block on the front page alike - a cancelled cleaning day
 * shown as going ahead sends somebody down to the courtyard on a Saturday
 * morning. And the month the calendar reaches has to be one answer: an anchor is
 * printed only for a month the clamp would leave alone, so there is no link that
 * answers with a different month from the one it named.
 */

const i18n = new I18nService();
let chrome: SiteChrome;

/** A Saturday cleaning day at 10:00 local, which is 08:00 UTC in April. */
const CLEANING_DAY: SiteEventDate = {
  eventId: "evt-staddag",
  title: "Städdag",
  category: "Städdag",
  location: "Innergården",
  startsAt: new Date("2026-04-18T08:00:00.000Z"),
  endsAt: new Date("2026-04-18T11:00:00.000Z"),
  cancelled: false,
  signupOpen: true,
  capacity: 20,
  placesTaken: 6,
};

/** A notice nobody signs up to, on the same day. */
const WATER_OFF: SiteEventDate = {
  eventId: "evt-vattnet",
  title: "Vattnet avstängt",
  category: null,
  location: null,
  startsAt: new Date("2026-04-20T06:00:00.000Z"),
  endsAt: new Date("2026-04-20T14:00:00.000Z"),
  cancelled: false,
  signupOpen: false,
  capacity: null,
  placesTaken: 0,
};

beforeAll(async () => {
  await i18n.init();
  chrome = {
    t: i18n.translatorFor("sv"),
    locale: "sv",
    associationName: "Brf Talgoxen",
    logoUrl: null,
    css: ":root { --obrf-surface-page: #EFEDE7; }",
    mediaUrl: (mediaFileId) => `/api/media/${mediaFileId}`,
    privacyNoticePath: null,
    menu: [],
    newsTeasers: [],
    eventDates: [],
    documents: [],
    roster: [],
    facts: null,
  };
});

describe("the month a parameter names", () => {
  it("is read strictly, or not at all", () => {
    expect(parseCalendarMonth("2026-04")).toEqual({ year: 2026, month: 4 });
    expect(parseCalendarMonth("2026-12")).toEqual({ year: 2026, month: 12 });
    // A month written without its leading zero is not a month this page ever
    // printed, so it is nobody following a link.
    expect(parseCalendarMonth("2026-4")).toBeNull();
    expect(parseCalendarMonth("2026-00")).toBeNull();
    expect(parseCalendarMonth("2026-13")).toBeNull();
    expect(parseCalendarMonth("2026-04-18")).toBeNull();
    expect(parseCalendarMonth("april")).toBeNull();
    expect(parseCalendarMonth("")).toBeNull();
    expect(parseCalendarMonth(undefined)).toBeNull();
  });

  it("is written back the way it is read", () => {
    expect(formatCalendarMonth({ year: 2026, month: 4 })).toBe("2026-04");
    expect(formatCalendarMonth({ year: 2026, month: 11 })).toBe("2026-11");
  });

  it("is the month an instant falls in on the association's own clock", () => {
    // Half past midnight on the first of April in Stockholm, which is still
    // March in UTC. The calendar dates it the way the notice in the stairwell
    // does.
    expect(calendarMonthOf(new Date("2026-03-31T22:30:00.000Z"))).toEqual({
      year: 2026,
      month: 4,
    });
  });
});

describe("moving between months", () => {
  it("steps over a year boundary in both directions", () => {
    expect(shiftCalendarMonth({ year: 2026, month: 12 }, 1)).toEqual({
      year: 2027,
      month: 1,
    });
    expect(shiftCalendarMonth({ year: 2026, month: 1 }, -1)).toEqual({
      year: 2025,
      month: 12,
    });
    expect(shiftCalendarMonth({ year: 2026, month: 4 }, 24)).toEqual({
      year: 2028,
      month: 4,
    });
  });

  it("keeps a month inside the span the calendar reaches", () => {
    const now = new Date("2026-04-18T08:00:00.000Z");

    // Twelve months back and twenty-four forward, and both edges are inside.
    expect(clampCalendarMonth({ year: 2025, month: 4 }, now)).toEqual({
      year: 2025,
      month: 4,
    });
    expect(clampCalendarMonth({ year: 2028, month: 4 }, now)).toEqual({
      year: 2028,
      month: 4,
    });
    // One step past either edge is pulled to it rather than refused.
    expect(clampCalendarMonth({ year: 2025, month: 3 }, now)).toEqual({
      year: 2025,
      month: 4,
    });
    expect(clampCalendarMonth({ year: 2028, month: 5 }, now)).toEqual({
      year: 2028,
      month: 4,
    });
    expect(clampCalendarMonth({ year: 9999, month: 1 }, now)).toEqual({
      year: 2028,
      month: 4,
    });
  });
});

describe("the calendar page", () => {
  it("is a whole document carrying the month and its dates", () => {
    const html = renderCalendarPage(chrome, {
      month: { year: 2026, month: 4 },
      previous: { year: 2026, month: 3 },
      next: { year: 2026, month: 5 },
      dates: [CLEANING_DAY, WATER_OFF],
    });

    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain('<html lang="sv">');
    expect(html).toContain("Kalender");
    expect(html).toContain("april 2026");
    // The date, its weekday and the hours the notice states.
    expect(html).toContain("lördag");
    expect(html).toContain("18 april 2026");
    expect(html).toContain("10:00-13:00");
    expect(html).toContain('<time dateTime="2026-04-18">');
    expect(html).toContain('href="/kalender/evt-staddag"');
    expect(html).toContain("Innergården");
    // The dates are in the order they happen.
    expect(html.indexOf("Städdag")).toBeLessThan(
      html.indexOf("Vattnet avstängt"),
    );
    // The one property the whole public site rests on.
    expect(html.includes("<script")).toBe(false);
    expect(/\son[a-z]+=/i.test(html)).toBe(false);
  });

  it("offers the two months either side as plain anchors", () => {
    const html = renderCalendarPage(chrome, {
      month: { year: 2026, month: 4 },
      previous: { year: 2026, month: 3 },
      next: { year: 2026, month: 5 },
      dates: [],
    });

    expect(html).toContain('href="/kalender?manad=2026-03"');
    expect(html).toContain('href="/kalender?manad=2026-05"');
    expect(html).toContain('rel="prev"');
    expect(html).toContain('rel="next"');
  });

  it("prints no anchor for a month it does not reach", () => {
    // At the far edge of the span there is nothing to link to, and a link that
    // answered with the month it was followed from would read as a fault.
    const html = renderCalendarPage(chrome, {
      month: { year: 2028, month: 4 },
      previous: { year: 2028, month: 3 },
      next: null,
      dates: [],
    });

    expect(html).toContain('href="/kalender?manad=2028-03"');
    expect(html.includes('rel="next"')).toBe(false);
    expect(html.includes("Nästa månad")).toBe(false);
  });

  it("says so plainly when a month holds nothing", () => {
    const html = renderCalendarPage(chrome, {
      month: { year: 2026, month: 4 },
      previous: null,
      next: null,
      dates: [],
    });

    expect(html).toContain("Inget är inplanerat den här månaden.");
  });

  it("says that a date has been called off", () => {
    const html = renderCalendarPage(chrome, {
      month: { year: 2026, month: 4 },
      previous: null,
      next: null,
      dates: [{ ...CLEANING_DAY, cancelled: true }],
    });

    expect(html).toContain("Inställt");
    // A place at an event that is not happening is not a thing to count.
    expect(html.includes("platser tagna")).toBe(false);
  });

  it("escapes what the board typed, like every other page", () => {
    const html = renderCalendarPage(chrome, {
      month: { year: 2026, month: 4 },
      previous: null,
      next: null,
      dates: [{ ...CLEANING_DAY, title: "<script>alert(1)</script>" }],
    });

    expect(html.includes("<script")).toBe(false);
    expect(html).toContain("&lt;script&gt;");
  });
});

describe("how many places are gone", () => {
  it("is a count against the limit the board set", () => {
    const html = renderCalendarPage(chrome, {
      month: { year: 2026, month: 4 },
      previous: null,
      next: null,
      dates: [CLEANING_DAY],
    });

    expect(html).toContain("6 av 20 platser tagna");
  });

  it("is the number who have signed up when there is no limit", () => {
    const html = renderCalendarPage(chrome, {
      month: { year: 2026, month: 4 },
      previous: null,
      next: null,
      dates: [{ ...CLEANING_DAY, capacity: null, placesTaken: 4 }],
    });

    expect(html).toContain("4 anmälda");
  });

  it("says the date is full rather than counting to the limit", () => {
    const html = renderCalendarPage(chrome, {
      month: { year: 2026, month: 4 },
      previous: null,
      next: null,
      dates: [{ ...CLEANING_DAY, placesTaken: 20 }],
    });

    expect(html).toContain("Fullbokat");
    expect(html.includes("20 av 20")).toBe(false);
  });

  it("is absent from a date nobody can sign up to", () => {
    const html = renderCalendarPage(chrome, {
      month: { year: 2026, month: 4 },
      previous: null,
      next: null,
      dates: [WATER_OFF],
    });

    expect(html.includes("anmälda")).toBe(false);
    expect(html.includes("platser tagna")).toBe(false);
  });
});

describe("one event's own page", () => {
  const EVENT: SiteEvent = {
    id: "evt-staddag",
    title: "Städdag",
    description: "Vi krattar löv.\n\nTa med egna handskar.",
    category: "Städdag",
    location: "Innergården",
    dates: [CLEANING_DAY, { ...CLEANING_DAY, cancelled: true }],
  };

  it("carries what it is and every date it falls on", () => {
    const html = renderEventPage(chrome, EVENT);

    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain("Städdag");
    expect(html).toContain("Datum");
    // The description as the board wrote it: a blank line is a paragraph.
    expect(html).toContain("<p>Vi krattar löv.</p>");
    expect(html).toContain("<p>Ta med egna handskar.</p>");
    // How to sign up, because the website takes no authenticated writes.
    expect(html).toContain("Anmälan görs när du har loggat in.");
    expect(html).toContain('href="/kalender"');
    expect(html.includes("<script")).toBe(false);
  });

  it("says nothing about signing up when the series takes none", () => {
    const html = renderEventPage(chrome, {
      ...EVENT,
      dates: [WATER_OFF],
    });

    expect(html.includes("Anmälan görs")).toBe(false);
  });

  it("stands without a description or a category", () => {
    const html = renderEventPage(chrome, {
      ...EVENT,
      description: null,
      category: null,
      dates: [],
    });

    expect(html).toContain("Städdag");
    // No heading over a list of dates that is not there.
    expect(html.includes("Datum")).toBe(false);
  });

  it("drops a description that is only blank lines", () => {
    const html = renderEventPage(chrome, { ...EVENT, description: "\n  \n" });

    expect(html).toContain("Städdag");
    expect(html.includes("<p></p>")).toBe(false);
  });
});

describe("a page carrying a calendar block", () => {
  const page = (count: number): SitePage => ({
    slug: "hem",
    title: "Välkommen",
    content: readPageContent({ blocks: [{ type: "eventCalendar", count }] }),
    publiclyReadable: true,
  });

  /**
   * A page nobody has just submitted anything on and which carries no form.
   * The block is what is under assertion here; the forms have their own tests.
   */
  const forms: SiteFormState = {
    pagePath: "/hem",
    publiclyReadable: true,
    sent: null,
    refused: null,
    issueTypes: null,
  };

  it("shows the dates it was handed, soonest first", () => {
    const html = renderPage(
      { ...chrome, eventDates: [CLEANING_DAY, WATER_OFF] },
      page(3),
      forms,
    );

    expect(html).toContain("På gång");
    expect(html).toContain("Städdag");
    expect(html).toContain("Vattnet avstängt");
    expect(html).toContain('href="/kalender"');
    expect(html.indexOf("Städdag")).toBeLessThan(
      html.indexOf("Vattnet avstängt"),
    );
  });

  it("shows no more than the block asked for", () => {
    const html = renderPage(
      { ...chrome, eventDates: [CLEANING_DAY, WATER_OFF] },
      page(1),
      forms,
    );

    expect(html).toContain("Städdag");
    expect(html.includes("Vattnet avstängt")).toBe(false);
  });

  it("says a date is called off, exactly as the calendar page does", () => {
    // The one thing the two renderings must never disagree about.
    const html = renderPage(
      { ...chrome, eventDates: [{ ...CLEANING_DAY, cancelled: true }] },
      page(3),
      forms,
    );

    expect(html).toContain("Inställt");
  });

  it("renders as nothing at all when there is no date to show", () => {
    // A page must not announce a calendar the association has not started
    // keeping, and an empty heading is also how a visitor would learn that the
    // members have dates they do not.
    const html = renderPage(chrome, page(3), forms);

    expect(html.includes("På gång")).toBe(false);
  });
});

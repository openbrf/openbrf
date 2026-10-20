/**
 * Where the pages the product builds live.
 *
 * One place, because the menu's generated entries and a button that leads to a
 * built-in page must agree: a rename made in only one of them would leave the
 * other pointing at an address nobody serves.
 */

/** Where the association's news lives, and the prefix every article sits under. */
export const NEWS_PATH = "/nyheter";

/**
 * Where the association's calendar lives, and the prefix an event sits under.
 *
 * One address for the calendar and one per event, and nothing per date. A
 * reader arriving at a cleaning day in April wants the series - what to bring,
 * and when the other cleaning days are - so the address is the series' and the
 * occurrences are what stands on it.
 */
export const CALENDAR_PATH = "/kalender";

/** Where the generated broker information page lives. */
export const BROKER_PATH = "/maklarinfo";

/**
 * What a stored page may hold.
 *
 * Here rather than beside the schema that enforces them, because the editor has
 * to know the same numbers: a board member who can add a fifty-first question
 * has built a page that cannot be saved, and is told so only once they press
 * save. One definition, so the screen and the write path cannot disagree about
 * what is too much.
 */
export const PAGE_CONTENT_LIMITS = {
  blocks: 200,
  runsPerBlock: 200,
  runText: 5000,
  link: 2000,
  alt: 300,
  caption: 500,
  /** How many news items one teaser block may ask for. */
  teaserCount: 10,
  /**
   * How many dates one event calendar block may ask for.
   *
   * The same number as the news teaser and for the same reason: a block on a
   * page is an invitation to the calendar rather than a copy of it, and a list
   * longer than this is the /kalender page's work. It is not the bound on how
   * far ahead the calendar itself reaches - that is a span of months and lives
   * with the page.
   */
  calendarCount: 10,
  /** The binder a document list narrows to. The archive's own bound. */
  category: 80,
  /** How many questions one FAQ block may hold. */
  faqItems: 50,
  faqQuestion: 300,
} as const;

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
  /**
   * What a button says. A call to action is a few words, and a label that
   * wraps over three lines on a telephone is a paragraph dressed as a button.
   */
  buttonLabel: 80,
  /** A banner's heading, as the one line it is meant to be read as. */
  bannerHeading: 120,
  /** The short text under a banner's heading: a sentence or two, not a page. */
  bannerText: 300,
  /** How many paragraphs a picture beside text may hold. */
  imageTextParagraphs: 20,
  /** How many columns a columns block may have: two or three. */
  columnsMin: 2,
  columnsMax: 3,
  /**
   * How many blocks one column may hold.
   *
   * A column is a third of a page's width, and twenty blocks in one is a page
   * of its own. The bound keeps a single columns block from carrying more than
   * the page limit allows the whole page.
   */
  columnBlocks: 20,
  /**
   * The id of a stored file or of a page, as a block refers to one.
   *
   * Every id the instance generates is far shorter. A bound rather than a
   * shape, because the id is looked up rather than parsed, and an id that
   * names nothing is answered as nothing when the page is written or rendered.
   */
  id: 64,
  /**
   * How large a block of a plugin that is not installed may be, as JSON.
   *
   * Such a block is kept without being understood, so its size is the one
   * thing about it this version can bound.
   */
  unregisteredBlock: 10_000,
  /**
   * How deep such a block may nest, counting the block itself as the first
   * level and every array or object inside it as one more.
   *
   * Within the size above, JSON can still nest some five thousand levels, and
   * whatever reads it next - a serialiser, a database, a plugin - should not
   * have to survive that to learn the block was never worth keeping.
   */
  unregisteredBlockDepth: 32,
} as const;

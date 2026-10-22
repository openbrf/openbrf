/**
 * The feed's limits, as the screen holds them.
 *
 * Mirrored rather than imported: each figure is the API's own, and the shared
 * package carries the wire's shapes rather than its limits. They are on the
 * fields so a writer is stopped by the box rather than by a refusal after they
 * have written the paragraph; the API enforces every one of them either way,
 * and one of these being wrong would cost somebody a refusal and nothing more.
 */

/** The longest post the API stores: `POST_MAX_LENGTH`. */
export const POST_MAX_LENGTH = 2000;

/**
 * The longest title a post written as Styrelsen carries:
 * `BOARD_POST_TITLE_MAX_LENGTH`, the news item's own.
 */
export const BOARD_POST_TITLE_MAX_LENGTH = 200;

/** The longest comment the API stores: `COMMENT_MAX_LENGTH`. */
export const COMMENT_MAX_LENGTH = 2000;

/** The longest name a group may carry: `GROUP_NAME_MAX_LENGTH`. */
export const GROUP_NAME_MAX_LENGTH = 80;

/** The longest search the API reads: `SEARCH_MAX_LENGTH`. */
export const SEARCH_MAX_LENGTH = 100;

/** How many images one post may carry: `MAX_IMAGES_PER_POST`. */
export const MAX_IMAGES_PER_POST = 4;

/**
 * How often the screen asks what has been posted since it last looked, and an
 * open thread what has been written under its post.
 *
 * Four seconds, recorded in ADR 0010. It is the only delivery path there is:
 * nothing is put on the feed by this screen, so a post or a comment reaches it
 * because a read brought it. Fast enough that the board writing to each other does not
 * feel like sending letters, and slow enough that ten open screens are two and
 * a half requests a second against an index scan that answers nothing most of
 * the time.
 *
 * The poll runs only while the tab is being looked at - see `use-poll.ts`.
 */
export const POLL_INTERVAL_MS = 4000;

/**
 * How long the screen waits after the last keystroke in the search before it
 * asks. A search is a few words typed in a row, and a read per letter would ask
 * the server about "s", "st" and "sto" on the way to "stopp".
 */
export const SEARCH_DELAY_MS = 300;

/**
 * How often the navigation asks how much is unread in the feed, on every screen
 * but the feed itself.
 *
 * Slower than the feed's own {@link POLL_INTERVAL_MS}, because it runs wherever
 * somebody is signed in rather than where somebody is reading the feed, and
 * ADR 0010 budgets the four-second poll for open feeds: every resident with the
 * overview or a booking open would otherwise be another request every four
 * seconds against a count nobody is waiting for. Half a minute is soon enough
 * for a badge that says "something new is there", and on the feed itself the
 * counts move on the feed's own poll.
 *
 * Paused while the tab is hidden, as every poll here is - see `use-poll.ts`.
 */
export const UNREAD_POLL_INTERVAL_MS = 30_000;

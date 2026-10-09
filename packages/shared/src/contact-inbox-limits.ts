/**
 * How many contact form messages one bulk removal may name.
 *
 * Here rather than beside the schema that enforces it, because the inbox has to
 * know the same number: the board can select more messages than this by reading
 * on page after page, and the screen sends such a selection in parts of this
 * size rather than as one request the server refuses whole.
 */
export const MAX_CONTACT_SUBMISSIONS_PER_REMOVAL = 200;

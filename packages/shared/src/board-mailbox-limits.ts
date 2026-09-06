/**
 * How much a board member may write in one reply.
 *
 * Generous, and bounded for the reason every free-text field in this product is:
 * a field with no limit is a field somebody can put a file in. A board answering
 * a letter writes paragraphs, not chapters.
 *
 * Here rather than beside the schema that enforces it, for the reason the page
 * content limits give: the form has to know the same number. A reply the field
 * accepted and the server refuses is refused after the board member has written
 * it, and a length is not something a screen can explain after the fact.
 */
export const MAX_REPLY_CHARACTERS = 20_000;

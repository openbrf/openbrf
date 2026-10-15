/**
 * How long a search of the address book may be.
 *
 * Here rather than beside the query schema that enforces it, because the
 * search field has to stop at the same length: a longer search was refused
 * with a 400, and the address book answered that with its failed state, which
 * takes the search field off the screen and retries the same search.
 */
export const MAX_ADDRESS_BOOK_SEARCH_LENGTH = 200;

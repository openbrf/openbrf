---
"@openbrf/web": patch
"@openbrf/shared": patch
"@openbrf/api": patch
---

The address book's search field now stops at the 200 characters the search accepts. A longer search was refused, and the address book then showed its failed state without the search field, so the only way out was to reload the page. The limit is shared as `MAX_ADDRESS_BOOK_SEARCH_LENGTH` in `@openbrf/shared`.

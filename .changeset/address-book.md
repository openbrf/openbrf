---
"@openbrf/api": minor
"@openbrf/web": minor
"@openbrf/i18n": minor
---

Add the address book: the board the register lives on, and the API behind it.

The board panel per the design system, with house tabs per address, on-board
filter tabs, floor-grouped rows following Lantmateriet numbering, the mono data
grid, role and state signs, the always-visible colour-as-law legend and a
register stamp. A person view and an apartment view beside it, search that
matches names and apartment numbers incrementally while an encrypted email or
phone number matches only in full, and pagination.

Masking is enforced server-side per the visibility matrix. The board sees
contact data with protected persons masked and a per-field reveal that writes its
audit entry in the same transaction as the read; residents see names, apartments,
roles and dates, with the contact column absent rather than empty, and protected
persons excluded from their view entirely apart from their own entry. A personal
identity number appears in no list, masked or not.

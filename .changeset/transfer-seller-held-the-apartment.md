---
"@openbrf/api": patch
"@openbrf/web": patch
"@openbrf/i18n": patch
---

Check the seller of a transfer against the register before the transfer is
recorded.

A transfer recorded with a move-in or a move-out now has to name a seller who
was a tenant-owner of that apartment when it passed on: a `MEMBER` residency on
it, held on the transfer day or up to it, so a seller who moved out on the day
of the sale still qualifies. A seller who never held the apartment, held it
only as a resident, or had stopped holding it is refused with
`seller-not-tenant-owner` (409), and a transfer naming the same person as
seller and acquirer is refused with `seller-is-acquirer` (400). Transfer rows
cannot be deleted, so both are refused before anything is written, and the
move they came with is refused with them.

The move takes the transition lock of both parties to the transfer, in a fixed
order, so the seller's residencies cannot change while they are checked.

The move-in and move-out forms show both refusals in the interface's own words.

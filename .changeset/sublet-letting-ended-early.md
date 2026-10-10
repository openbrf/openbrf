---
"@openbrf/api": minor
"@openbrf/web": minor
"@openbrf/i18n": minor
---

Let the board record that a consented subletting ended before its period did.

A granted erasure request keeps a consent while its letting runs, and it took
the period's last day as the end of the letting. A letting that stopped early
held the request open, and kept the application, until the end of a period
nobody was using. Nothing could shorten it.

The board can now record the day the letting ended, on a consented row in the
subletting queue or with `PUT /api/sublet-queue/:id/letting-end`. The day must
fall inside the period consented to. A request against any other application
is refused as `not-consented`, and a day outside the period as
`letting-end-outside-period`. The board can clear the record again. Each
change writes a `SUBLET_LETTING_END_RECORDED` audit entry.

From the day after the recorded last day, a granted erasure request no longer
waits for the consent, and the two-year retention window counts from the later of the
board's answer and the day after that last day (the day is inclusive: the
letting runs through it). The period itself stays what the board consented to. The applicant sees the day on their
own list, and the data subject access report shows it beside the period.

Migration `20261010100000_sublet_letting_ended_on` adds the column, with a
check constraint for the same rules.

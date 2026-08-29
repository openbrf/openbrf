---
"@openbrf/api": minor
"@openbrf/web": minor
"@openbrf/i18n": minor
"@openbrf/shared": minor
---

Record what a person has agreed may be published, and widen the audit log to
cover the acts that decide access.

Publication consent (publiceringssamtycke) is now a record the board keeps, on
the person view beside the protected personal data flag. It covers one scope at
a time - a photograph, a name on the website, the published board roster -
because agreeing to be named is not agreeing to be photographed. Granting and
withdrawing are dated facts rather than a switch: a withdrawal closes the
consent with a date and leaves the row on file, so the period a consent covered
stays readable, and that period is what says a page published while it stood was
published lawfully. A person who agrees again is recorded again, beside the
earlier consent rather than over it. Every change writes an audit entry in the
same transaction, and a change that changes nothing writes neither an entry nor
a date. The field is the board's, on the board's own person view: the
resident-facing directory has no person view at all.

The audit log gains the vocabulary for the acts that decide who reaches the
association's data. An invitation now records both halves - the board issuing
the link and the recipient using it - and a self-signup decision records the
approval or the rejection, each in the same transaction as the decision itself,
so a board member who loses the race to decide a request writes nothing. A theme
written on the instance is recorded as composed as well as installed, which is
the difference between tokens authored here and a package downloaded from a
catalog.

The personal identity number's parse, canonical form and checksum move into the
shared package, unchanged byte for byte, and gain a scanner that finds one in
free text. The scanner is what lets a personnummer be refused at the keyboard
rather than after a page is live: candidates are matched by shape and then put
through the same validator a stored value goes through, so the calendar and the
checksum are what decide. An organisation number is left alone - a housing
cooperative prints its own in its footer, and the third digit pair of one is
never a month.

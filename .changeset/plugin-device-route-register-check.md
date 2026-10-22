---
"@openbrf/plugin-sdk": patch
"@openbrf/api": minor
"@openbrf/web": minor
"@openbrf/i18n": minor
---

Keep published text that names a resident off every device (ADR 0032).

For a plugin that declares a device route, `host.news`, `host.calendar` and
`host.bookings` now run the register check on every read. A news item, an
event, a meeting notice or a bookable resource is absent, whole, when one of
its strings holds the name of a person the register holds (current or former,
protected personal data included), one of their email addresses or phone
numbers, or an apartment number. Names and apartment numbers match as whole
words, ignoring case; a given name only where it begins with a capital letter,
and a name in the genitive as well. A phone number matches by its digits
however they are spaced. A withheld item looks the same as an unpublished one:
a news read goes on to older items to make up the count. `busy` starts no
earlier than the moment of the call for such a plugin, so it shows no booking
that has ended.

The email addresses and phone numbers are looked up by their blind index, so
the check decrypts nothing. A plugin without a device route reads exactly what
it read before.

The news, calendar, meeting notice and bookable resource editors mark an item
that is withheld from devices and show the words that caused it, so that the
board can rephrase it. A word that names only somebody with protected personal
data is not shown: the editor says that the text names somebody in the
register. The mark comes from its own read under each editor's capability. It
is not an action, so no connected app reads it, and it is closed to support
sessions.

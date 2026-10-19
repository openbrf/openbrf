---
"@openbrf/api": patch
"@openbrf/web": patch
"@openbrf/i18n": patch
"@openbrf/shared": patch
---

A member list can now be imported again whenever a newer file arrives. A file
is recognised by its column titles: the mapping the board last started an
import from such a file with is offered in place of the guess, and a file that
holds exactly the rows imported last is answered with "nothing new in this
file" instead of a preview, with a button to review it anyway. A file the
register did not take whole, because rows had problems or the import stopped,
is always reviewed.

The preview of a file imported again tells the rows the register already agrees
with ("No change") apart from the updates that change it, and says what each of
those adds: an email address, a phone number, a postal address or a residency.
Below the rows it lists the residencies current in the register that no row of
the file reaches. That list is for reading only: the import never ends a
residency, because a file that leaves somebody out does not say they have
moved.

A preview planned before this version, in a session uploaded within the last
day, is reported as outdated and taken again.

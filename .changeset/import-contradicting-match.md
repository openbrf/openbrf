---
"@openbrf/api": patch
"@openbrf/web": patch
"@openbrf/i18n": patch
---

Let the board decide an import row that contradicts the person it matched.

A row matched through an email address, or through the apartment and a name,
now waits for a decision when its personal identity number differs from the
matched person's, and an email match also waits when the name differs. The
preview says which of the two differs and offers the person as a choice, as it
does for a row that matches more than one person.

An import no longer adds a personal identity number to a person it matched
through an email address or a name. Such a match still fills in the other
fields the register does not have.

The persons earlier rows of the same file create or fill in are held to the
same rules. A row with the email address of an earlier row but another name or
identity number waits for a decision instead of being folded into that row's
person, and the preview now finds such a row however far down the file it is,
so an import no longer stops partway through a long file at a row the preview
showed as an update.

The preview names the person each matched row will be written to, and says
when a row's personal identity number will not be added to that person.

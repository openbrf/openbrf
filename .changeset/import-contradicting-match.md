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

The preview names the person each matched row will be written to.

---
"@openbrf/api": minor
"@openbrf/web": minor
"@openbrf/i18n": minor
---

Add the document archive: the association's own documents, each for a stated
audience.

The board files the bylaws, the minutes, the house rules and the annual report
into binders it names itself, and gives each document one of three audiences:
the board, the members, or anyone. There is no separate capability for
reading: the audience on the document is the whole of the rule, and which
audiences a person is inside follows from who they are - the members' shelf
from the tenant-ownership they hold, the board's from the capability that
manages the archive, and the published one from nothing at all. So the board
sees all three shelves, a member sees theirs and the published one, a resident
who is not a member sees what is published, and a visitor with no account can
open a published document at its own address.

The audience is enforced on the file rather than only on the list, for all
three of them. Filing a document writes the same decision onto the stored
file, and changing it later rewrites both in one transaction: a document taken
off the public shelf takes its file off the street in the same breath, instead
of staying fetchable by anyone who had seen the address while it was
published. A document kept to the members is readable by whoever holds a
tenant-ownership, and by the board and an administrator who manage the archive
on their behalf - not by every account that happens to be signed in, so a
resident who is not a member gains nothing from holding the address. A
document kept to the board is narrowed further still, to the capability that
manages the archive, and that narrowing is what puts every opening of one in
the audit log. The members' shelf is deliberately left out of that record:
members read their own association's papers as a matter of course, and a row
for each would say who read what rather than hold anyone to account. Documents
are served by the route that already serves the association's mark, so a
public document sets no cookie and no second serving path exists to get the
decision wrong differently.

Minutes of a general meeting name the members who spoke and how they voted, so
they go to the members: choosing the minutes binder takes a document off the
public shelf, and publishing a particular set is then a second, deliberate
answer. New documents are the members' by default, in the interface and in the
database column both.

Managing the archive is a new capability, granted to the board and to an
administrator. Uploads accept documents as PDF beside the images the platform
already took, identified from their own bytes like everything else that is
stored - a file that opens as a document but does not close as one is refused,
whatever it is named.

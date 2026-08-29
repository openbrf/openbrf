---
"@openbrf/api": minor
"@openbrf/web": minor
"@openbrf/i18n": minor
---

Erase service data when its retention window runs out, keep it where the law
says to, and answer a person who asks what the association holds about them.

The retention policy has shown a purge date on every ended residency since the
register was built, and until now nothing acted on it. A job runs each night
and does: for somebody whose last residency ended longer ago than the policy
allows, it clears the email address and phone number with the blind indexes
that made them searchable, resets the stated language, deletes the sign-in
account with its sessions and credentials, and deletes any invitation that was
never accepted. The name and the postal address stay, because the member
register is public on request and one that lost its members' names would not be
a register. The personal identity number stays too: it is confidential
apartment register content rather than service data, which is why it is masked
from every screen and reachable only through the audited reveal.

The member register, the transfers, the lien notes and the audit log are not
merely excluded from the erasure - nothing can erase them. The database
refuses to update or delete a row in any of them, and the job is built on that
rather than on remembering to leave them alone. Each person is erased in a
transaction of their own, so a run interrupted half way through leaves what it
finished finished and finds the rest the following night; a person already
erased is not selected again, so nobody collects an entry a night for ever in a
log that cannot be tidied. Somebody still sitting on the board, still holding
an administrator or property manager grant, or still living in another
apartment is left alone, because none of those relationships has ended.

A legal hold is the one thing that suspends the purge, and the board places one
against a named person with a reason it has to write down. It is for data the
association still needs in order to establish or defend a legal claim, or that
the law obliges it to keep: a dispute, an insurance matter, a request from an
authority. Releasing it erases
nothing by itself - it makes the person erasable again and the job runs in its
own time - and the released hold keeps the dates it stood between, because that
record is the explanation for why nothing was purged in that period. The person
view says in words that a hold stands, beside the purge date it has stopped
applying to, and the retention setting says that the erasure now happens by
itself.

The data subject access report is everything the association holds about one
person on one printable document: the register entry with the contact details
and the personal identity number decrypted, the residencies with the date each
one is erased on, positions of trust, system roles, the account, the statutory
member register entries and transfers, publication consents, legal holds,
issues reported, documents filed, and the audit log both about them and of
what they did. It is produced by the board from the person's own view, gated on
the capability that governs every other deliberate disclosure of masked data,
and written to the audit log as an export in the same transaction that reads
it. There is no public path to it and no way to send it: it is printed and
handed over. Issues and archived documents are listed on it but are not yet
purged - their retention windows are a decision of their own - and the document
says which half of what it lists is erased and which half the law requires the
association to keep.

An audit entry now carries facts rather than prose. The log is append-only and
outside every purge scope, so free text copied into it outlives the record it
described: a rejected sign-up request carries a purge date and the entry about
it does not. Entries name the record and let the text be read from there, which
is why the rejection reason is on the request rather than in the log a second
time. What an entry may still carry is a reason somebody typed for the log
itself - why a protected person's data was revealed - because that has no other
home and is what lets the record answer why, and not only who and when.

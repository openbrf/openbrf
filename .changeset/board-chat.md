---
"@openbrf/api": minor
"@openbrf/web": minor
"@openbrf/i18n": minor
---

Add the board's own chat: a room for the people holding a seat, and what becomes
of what they write in it.

A chat is a running conversation between a fixed set of people, read and written
nowhere else. It is not a thread, which is one correspondence the board mailbox
holds with somebody outside the association about one matter, and not a comment,
which sits under one news item and is as visible as that item: a chat has members
and no subject. There is one room today, the board's own, and its members are not
written down but derived - everybody holding a board seat that has not ended. A
person joins it the day their term is recorded and leaves it the day the term
ends, without anybody administering a list. A full discussion forum is
deliberately never built.

The capability opens the endpoints and membership decides what is in them, and
the two stay separate questions. `chat:participate` is the board's, so a resident
and a member are both refused the routes, and the external property manager is
refused on the same footing as a news comment - they handle the association's
issues and were not elected to anything. The administrator holds every capability
through the ADMIN grant and holds no seat, so they reach every route and find no
room; the screen says why in Swedish rather than rendering an empty conversation,
because a room whose membership comes from an election is not something a grant
can open. A room that does not exist and a room somebody is not in are one
refusal, so the identifier space cannot be walked to learn what rooms the
association has.

Nothing is ever erased except by the retention clock. There is no edit, no
delete and no withdraw, by the author or by anybody else, and no strike-through
either - which is where the board chat parts company with a comment thread. A
thread under a notice is part of what the association publishes and the board
answers for it; the board chat publishes nothing and the board is the whole room,
so a board able to strike a colleague's line would be deciding what the record of
its own deliberation says.

Nothing is rendered on the association's website, which reads no session at all,
and the module imports nothing from it and exports nothing to it.

Delivery is a poll and not a stream, recorded in ADR 0010 along with what was
rejected and why. A screen asks for what has been written since a cursor it was
given, every four seconds, and only while the tab is being looked at - a
forgotten tab on a phone would otherwise ask for days, and one request is made
immediately when the tab comes back, because that is when somebody wants what
arrived while they were away. Nothing is appended by the browser: a written
message clears the box and a read brings the row, which is what makes the poll
the one delivery path rather than a second opinion about one. Both directions of
the cursor survive a message purged out from under a reader, and the poll answers
a bounded page and says whether more is waiting, so a screen closed for a week
catches up a page at a time instead of asking for a week of messages at once.

Nothing notifies by mail, and there is a read marker instead - one row per person
per room, so the screen can say what is unread. It only ever moves forward, so
two tabs cannot un-read each other, and it is marked at the newest message
actually on screen rather than at the moment of the call.

A personal identity number refuses the message, naming the position in the text
and never the number. The board may read the apartment register, and that is
exactly why the rule holds here: a number copied out of it into a service-tier
room is a second copy the register cannot account for, held on a different clock,
in a room the register's own rules do not reach. A message is capped in length
and each person has a budget of messages per ten minutes, counted from what they
actually wrote so that it survives a restart and is the same budget in every
process.

A message write is not audited, and the departure from the comment precedent is
deliberate. A comment's audit entry exists because a member's own words about a
notice are their data and their access report has to say when they wrote them; a
chat message is on that report in full, carrying its author and its instant, so
the entry would restate the row. A board of eight at thirty messages a day is
about eleven thousand rows a year in a table the database refuses to update or
delete and every purge is forbidden to touch. What is audited is the acts that
change who can read a room, and in the board chat there are none: nobody is put
into the room or taken out of it, an election is.

Every message is on the data subject access report and in the portability export,
in full, grouped by the room it was written in and carrying the earliest date the
purge can reach it. The read marker travels with the room rather than as a
section of its own. Only the reader's own messages are there - a room's other
members wrote about themselves and about the association's business, and a report
carrying the whole room would hand one board member everything the other seven
said. An author with protected personal data is named to nobody, every reader of
the room included, although each of them holds the capability to reveal protected
data with their seat: that capability is what lets somebody perform an act of
revealing and be recorded doing it, and a name appearing in a payload nothing
audits is not that act.

A nightly job erases messages a year after they were written, on each message's
own clock rather than the room's. A chat has no end, so anchoring on the last
message would mean a room somebody writes in every week purges nothing, ever. A
legal hold standing against the author stops it, inside the eligibility query as
well as inside the deleting transaction, so held people can neither be erased nor
fill a run with work that cannot be done. The chat has its own record of
processing activities entry under GDPR art. 30 rather than joining one.

The room model carries a kind from the first migration, with a second value in
the enum that the service refuses. A group's chat is built next, and the
discriminator being there already is what keeps that from being a migration over
live rows.

# ADR 0012: Moderating a room the board cannot see

Date: 2026-09-18

## Status

Accepted

## Context

A group chat is a room somebody who lives here makes for something the house is
doing - a work party, a stairwell, a garden committee. Nobody appoints it: the
association does not create it, does not approve it and does not publish it, and
it is invisible to anybody who is not in it. A room it does not hold is refused
exactly as a room that does not exist, so the identifier space cannot be walked
to learn what rooms a cooperative has made.

That leaves a question every other room in this product answers by itself. A
comment thread under a notice is part of what the association publishes, so the
board moderates it under the capability it publishes with. The board's own chat
needs no moderation at all, because the board is the whole room and a board able
to strike a colleague's line would be deciding what the record of its own
deliberation says. A group is neither: it publishes nothing, and the board is
not in it.

Two answers were available and both are wrong.

**No moderation at all.** A resident being written about by four neighbours in a
room the association hosts would have nowhere to go, and "we cannot see it" is
not an answer a cooperative can give about software it runs. The association is
answerable for what its platform holds.

**The board can open a group.** It would end the room. A group is worth having
because the people in it can speak to each other; one a board can read on its
own initiative is a room with the board in it, whatever the screen calls it. It
would also make the invisibility a fiction: the moment there is a list of groups
for the board to read, there is a list.

## Decision

**The board reaches a group only through a report from inside it, and a report
carries one message.**

A member of the room reports a message. That report is what makes the message
readable by the board, and it makes nothing else readable: not the message
before it, not the room's other members, not the room. The board reads a queue
of reported messages, each with the room's name beside it, and answers each one
of two ways - struck through, or left standing.

Four things follow, and each is enforced rather than merely intended.

**There is no route that takes a room or a message.** Every moderation route
takes a report identifier, so a board member cannot strike a message nobody
reported, and cannot ask about a room at all. That is what keeps "only through a
report" a property of the code rather than a rule somebody has to remember.

**Striking withholds and never erases.** The message stays where it is with its
author's name on it, its text withheld from the other people in the room,
readable to whoever wrote it and to the board, and on the retention clock it was
always on. Nothing clears a strike: it is a dated close on the row, and the audit
log records who decided it.

**The act is the chat's own, not the website's.** It sits behind
`chat:moderate` rather than `site:manage`. That capability was argued from a
thread being part of what the association publishes, and a private room publishes
nothing. It is a second capability rather than `chat:participate` because that
one is every resident's: a strike-through granted to everybody who lives here
would be no rule at all.

**The report row is the record.** Reporting writes no audit entry. The row holds
who reported what, when, and what the board decided, which is more than an entry
naming the act could carry - and unlike an entry, which is append-only and
outside every purge, it is erased with the message it is about. What the audit
log records is the acts that change who can read a room: making one, putting
somebody into one, somebody leaving, and striking a message through.

## Consequences

A board can be asked to look at something and cannot go looking. That is the
trade, and it is deliberate: the association can answer a resident who is being
written about, and it cannot read the rooms of a house that has done nothing
wrong.

A group with nobody willing to report is unmoderated. The alternative is a board
that can open any room, which is the thing this record refuses. A cooperative
whose group has gone wrong and whose members will not report it has the remedies
it has outside this software.

The queue is the only place a group's name reaches the board, and it reaches it
one report at a time. A board that has never had a report cannot tell whether
this cooperative has groups at all - which is the same answer the product gives
everybody else who is not in one.

**The revisit trigger.** A cooperative asks for a way to see that groups exist
without seeing what is in them - a count, or a list of names. That is a real
question about governance rather than about moderation, and it would be a
different record: the argument here is about reading what was said, and a count
says nothing about anybody. It is not built until somebody asks.

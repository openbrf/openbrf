---
"@openbrf/api": minor
"@openbrf/web": minor
"@openbrf/i18n": minor
---

Add motions to the general meeting: the table, the two capabilities, the
member's intake and the board's queue, with the retention story a person-linked
table has to arrive with.

The right belongs to a member and not to a resident. EFL 6 kap. 15 § gives a
member the right to have an item treated at a general meeting if they ask the
board in writing in time for the item to be taken up in the notice, and
BRL 9 kap. 14 § applies that chapter to a housing cooperative with six
exceptions of which this is not one. So `motions:submit` is the first capability
this platform derives from membership rather than from residency, a board seat or
an administrator grant: a partner, an adult child or a tenant living in the house
is offered nothing, and neither is a board member who holds no tenant-ownership,
because the right attaches to the membership and not to the office. The register
is asked again before a motion is written, which is what settles the
administrator case - a grant on an instance holds every capability the model
defines and is not a share in the association. The same paragraph withholds the
right from a member who has been excluded even though the membership has not yet
ended; this platform records no exclusion, so that case is not subtracted, and
the check says so where it is made rather than pretending otherwise.

The deadline is the association's own. The same paragraph leaves the manner and
the time to the bylaws, so it is recorded on the instance settings as a recurring
month and day - a standing clause rather than one year's date - with no default
at all: an association whose bylaws are silent has no deadline, intake stays open
and the board decides what it can still take up. Nothing refuses a late motion,
because the deadline decides which meeting an item can reach rather than whether
the association may receive it. The board reads the clause with the settings it
answers for, and an administrator changes it.

A motion carries a title, the proposal, and the member who submitted it as a
plain reference the purge can erase around. It is received rather than approved:
the board records that it has the item, whether the meeting adopts the proposal
is minuted at the meeting, and there is no route that rejects one. A motion
closes with a date and a status - acknowledged, or withdrawn by the member while
it was still open - and is never deleted, because the record that a member put
something to the meeting is theirs. It deliberately carries no meeting reference:
linking a motion to the meeting it is taken up at arrives with the meetings
module.

The title and the proposal are scanned for a personal identity number and refused
if they carry one, with the field named and the value never echoed. Unlike an
issue description, which is neither scanned nor refused, a motion is circulated -
into the notice, read out in the room, into the minutes - so it travels the same
publication guardrail a page and a news item do.

Same change, because this is the change that creates the table: the data subject
access report carries a person's motions in their own words with the date each
becomes erasable, a nightly purge erases a motion two years after it closed, and
a legal hold stops it for the person it stands against - re-checked inside the
deleting transaction under the advisory lock, so a hold placed while a run is in
flight wins. An open motion is never purged: the association is still processing
it, so the purpose it is held for has not ended.

The screens, the navigation entry and the end-to-end suite follow separately.

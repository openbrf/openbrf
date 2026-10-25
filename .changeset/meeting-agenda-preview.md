---
"@openbrf/web": minor
"@openbrf/i18n": patch
---

A proposed agenda change on the pending-changes screen now shows which meeting
it is: its kind and day, the agenda the meeting has now beside the proposed
one, and the items the proposal removes. A line says when the agenda has
changed since it was proposed, so confirming would be refused, and when the
notice is issued or the meeting is recorded as held. The meeting is read again
after another change on the screen is confirmed or rejected, and when confirming
this one is refused, so a second proposal for the same meeting is shown beside
the agenda the first one left. The exact input, with its ids, is still shown
below. A person who may confirm the change but may not read meetings sees
only that input, with no agenda heading and no failure notice.

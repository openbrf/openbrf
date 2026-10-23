---
"@openbrf/api": minor
"@openbrf/i18n": minor
"@openbrf/shared": minor
"@openbrf/web": patch
---

The AI package can now propose a general meeting's agenda. The board member who
asked for it confirms the proposal before anything is written. The proposal
replaces the whole agenda and names the agenda it was drafted against, so a
proposal confirmed after somebody rewrote the agenda is refused as out of date
instead of overwriting the newer agenda. The agenda cannot be changed once the
notice has been issued or the meeting has been recorded as held. The confirmed
change is recorded as the confirming board member's own, made on the web, and
its audit entry names the proposal that led to it. The board's own meetings
screen writes the agenda as before.

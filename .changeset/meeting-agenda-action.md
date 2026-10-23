---
"@openbrf/api": minor
"@openbrf/i18n": minor
"@openbrf/shared": minor
"@openbrf/web": patch
---

The AI package can propose a general meeting's agenda for the board member who
asked for it to confirm. `meeting_set_agenda` replaces the whole agenda, needs
`meetings:manage` and is offered on `ui` and `ai`, not on `mcp`. On `ai` it can
only be proposed as a pending change. Its input names the agenda it replaces by
the ids of its items, so a change confirmed after somebody rewrote the agenda
is refused with the new reason `agenda-changed` instead of overwriting the newer
one. It is refused once the notice has been issued or the meeting has been
recorded as held. The confirmed write is recorded as the confirming board
member's, on the web channel, and its audit entry names the pending change. The
board's own meetings screen writes the agenda as before. ADR 0041 records the
decision.

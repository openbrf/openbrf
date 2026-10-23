---
"@openbrf/api": minor
"@openbrf/i18n": minor
---

A connected app can read the association's general meetings for the board.
`meeting_list` lists the meetings with their day, kind, whether the notice has
been issued and the number of agenda items. `meeting_get` reads one meeting
with its agenda, the outcome and vote totals of each decision, and the time and
place in its notice. Both need `meetings:manage` and are offered on `mcp` and
`ai`. Neither returns who attended, the proxy authorisations, the voting
register, individual votes or which members the notice did not reach. ADR 0041
records the decision, including the document reads that follow in a separate
change.

---
"@openbrf/web": patch
"@openbrf/i18n": patch
---

Let the board close a person's request about their own data after it has been
decided, so a granted restriction or objection can be lifted again.

Closing is what lifts a restriction (GDPR art. 18) or an objection (art. 21),
and the person's page offered it only until a decision was recorded, which left
every granted one in force for good. It is now offered for as long as the
request is open, and a decision is offered only on an open request that has none,
so a request closed without a decision offers neither.

Closing now takes two presses: the first says what closing this request lifts,
the second closes it with the reason the board writes, which is required. The
button is busy while the closure is sent, and pressing it again sends nothing.

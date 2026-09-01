---
"@openbrf/api": minor
"@openbrf/web": minor
"@openbrf/i18n": minor
---

Add the screen the house reads the association's news on, with the comment
thread under each notice.

One destination for whoever lives in the building: the published notices newest
first, the one that is open with its body, and the thread under it with a box to
answer in. `news:comment` is what opens it, and that capability is a resident's
rather than a member's - answering a notice about the building one lives in is
not the statutory right that membership carries, and membership adds exactly one
capability in this platform. A partner, an adult child and a tenant therefore
reach it exactly as a tenant-owner does, while the external property manager
reaches neither the destination nor the endpoints behind it. The board's own
`site:manage` adds the strike-through control to each comment and nothing else,
so the writing screen and the reading screen stay two screens for two acts.

The notices are served by a reader endpoint of their own, under the same
capability as the thread. Which items a reader is offered and which threads open
to them are one question, so one service answers both: what is on the list is
what has a thread, a draft is on neither, and the identifier a thread is
addressed by is the one the list carries. A body is narrowed to prose on the way
out exactly as the website narrows it, and a link whose scheme this platform does
not publish is dropped by the parser rather than by the browser.

A struck-through comment is rendered as the server answers it, per reader, and
the screen holds no rule of its own about who may read one. The comment keeps its
place in the thread and its author's name in every case: with its text struck
through for the board and for whoever wrote it, and with a sentence saying the
board has taken the text off the thread for everybody else. There is no control
that clears a strike-through, because there is no endpoint for one.

Nothing on the screen is optimistic. A posted comment and a struck one both ask
for a fresh read of the thread rather than editing the list in place, one reading
effect owns every read, and each row carries its own busy state - so after two
acts crossing, what is on screen is the thread the server last described rather
than whichever response happened to arrive last. Every refusal the endpoints can
answer with has a sentence, and the personal identity number refusal names the
rule without carrying the number back onto a screen the whole house reads.

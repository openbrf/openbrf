---
"@openbrf/api": minor
"@openbrf/web": minor
"@openbrf/i18n": minor
---

Keep moderation on a taken-down notice, and read a comment thread a page at a
time.

Striking a comment through no longer tests whether the notice above it is
published. Publication decides who may read a thread and who may write into one;
it decides nothing about the board's one act over a comment already on one, and
the text a board most wants struck is often exactly the text it took the notice
down over. The not-found answer stays where it belongs, on the comment that is
not there. Reading a thread and writing into it are unchanged, because there the
caller holds `news:comment` and a draft has to stay invisible; an author's own
words were already answered without regard to publication by the data subject
access report, and still are.

The strike-through is now a conditional update taken before any read, so two
presses in the same instant are one act with one audit entry rather than two.

The thread endpoint answers a bounded page from the newest end and the cursor for
the page before it, and the reading screen carries the control that asks for it.
The cursor is the instant and the identifier of the comment the page ended at:
the instant alone is not a total ordering, and a page boundary on a tie either
repeats comments or loses them. A page size on its own would have been worse than
the unbounded read, because a comment missing from a discussion reads as a
moderation nobody performed.

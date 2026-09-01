---
"@openbrf/api": patch
"@openbrf/web": patch
---

Keep the line breaks in a fault report's description on the data subject access
report, and correct three section counts that had gone stale as sections were
added.

An issue description was the one piece of somebody's own writing on the document
that collapsed to a single line, while the motion body, the comment body and
both issue panels keep theirs. A description written as a list of observations
read as one run-on sentence, which is the association altering what it hands
back under art. 15.

The counts: the lien note called itself the only section not keyed on a person
column after the termination became the second, and the web mirror said three
sections state a per-row retention date where four now do.

The issues section had no fixture row in the report's own test, so nothing
rendered it. It has one now, written on three lines, and one test asserts all
three free-text sections keep their breaks so a fourth cannot arrive without it.

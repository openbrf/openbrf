---
"@openbrf/web": patch
---

On the general meeting screen, "Dagordningen är sparad." and "Beslutet är
antecknat." no longer outlive the draft they confirm: the first edit to the
agenda, or to a decision's outcome, counts or closed ballot, takes the
confirmation away. A save still in flight when another meeting is opened no
longer puts its confirmation on that meeting.

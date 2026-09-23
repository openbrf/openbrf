---
"@openbrf/api": minor
"@openbrf/web": minor
"@openbrf/i18n": minor
---

The papers about an apartment can be kept with the apartment, for whoever lives
there.

A lägenhetspärm is the binder about one home: its drawings, the board's
permissions for what has been altered, what was done and when, the manuals for
what is installed. On paper it passes from seller to buyer with the keys, and
that is what this is. Nothing in the service tier worked that way before: every
resident-facing list filters by the person who created the row, and the one
record that already follows the apartment is the statutory register extract.

An entry is one PDF with one of six kinds, a title, a date where the kind has
one, and an audience: the tenant-owners, or the whole household. The two are
different people and the register cannot tell them apart any more finely - a
partner, an adult child and a second-hand tenant are one residency role - so a
permission's conditions go to the tenant-owners and the dishwasher's manual to
everybody living there.

Reading follows the residency and is decided on every request. When the
apartment changes hands nothing happens at all: no job, no hook, no copy. The
next household reads the binder from the day its residency begins and the last
one stops on the day its residency ends. A buyer the board recorded before
tillträde reads nothing, because a residency is held from its move-in day.

The board's permission under BRL 7 kap. 7 § is a kind only the board can file,
and it carries the day the board decided - both held by the database as well as
by the service, because what the binder is worth to the next holder is that
tillstånd means the board said so. It is stated and never enforced: the section
gives the permission to the tenant-owner and says nothing about whether a
condition binds the next one, so the platform says nothing either.

The board reads every binder through a capability a board seat confers and
nothing else does. This is the first capability the administrator's grant
withholds, and it is withheld in the types rather than by a branch: an
administrator who holds no seat - including whoever operates a hosted instance -
is answered 404 for a household's papers, at the list and at the file alike. An
association whose administrator needs to reach a binder gives them a seat. Every
serve of a binder file to somebody reading it as the board is written to the
audit log; a household reading its own binder is not, because its residency is
the whole of that rule.

A binder names nobody. An entry says whether the board or a tenant-owner filed
it, and the reader is told which are their own, and that is all - one rule for
every household rather than a rule with an exception for people who live
together, which is also what protects a tenant-owner with protected personal
data. The file name a household uploads stays off the audit log, which is
append-only and exempt from every purge. A title carrying a personal identity
number is refused, naming the field and never the number; the file itself cannot
be read for one, and the form will say so.

The files are encrypted at rest, each under a key of its own, like every other
stored file, and the association's record of processing activities gains a row
that says so.

There is no screen yet. This is the schema, the two per-apartment file
visibilities, the API, the purge, the access report and the paperwork; the screen
follows.

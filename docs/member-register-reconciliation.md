# Checking the member register against the tenant-ownerships held

The member register (medlemsförteckning) is derived from the tenant-ownerships
the register holds: a person is a member on every day they hold a `MEMBER`
residency. Moves and the member import have written the register's ENTRY and
EXIT rows by the move's date since the release that also ships this check.
Before that, the rows depended on the order the moves were recorded in, and a
register written then can disagree with the residencies. One example: an import
that listed a person's apartment A, held 2010-2015, before apartment B, held
from 2012, wrote an EXIT in 2015 and no ENTRY for B, so the extract shows a
current tenant-owner as having left.

`openbrf member-register reconcile` finds such disagreements and, when asked,
appends the rows that settle them.

## When to run it

Once, after upgrading an instance that recorded moves or ran a member import
before this release. An instance set up on this release or later has nothing
to find, and running it there is harmless.

## How to run it

On the production stack, with `compose` as in [deployment.md](deployment.md):

```
compose exec app openbrf member-register reconcile
```

That is a report and writes nothing. It lists each person whose register
disagrees, with the rows it would append, and each person with register rows
older than any tenant-ownership on record. Read it, and check a person or two
against what the board knows. Then append the rows:

```
compose exec app openbrf member-register reconcile --apply
```

Person ids after `reconcile` limit the run to those people, which is a way to
look at one case before running the whole register.

## What it writes, and what it leaves alone

- **Only new rows.** The member register is append-only by law (EFL 5 kap.,
  through BRL 9 kap.) and by database trigger, so nothing is edited or removed.
  A wrong EXIT stays, and an ENTRY on the same day records that the membership
  went on. The extract then shows two memberships meeting on that day, which is
  true of every day in them.
- **A note on every row it appends**, saying the register was checked against
  the tenant-ownerships held. Each row carries the person's name and postal
  address as they stand now, as every new register row does.
- **Nothing before the person's first `MEMBER` residency.** Rows from before
  then, and the register of a person with no `MEMBER` residency at all, are
  reported and left as they stand. The residencies cannot speak for them, and a
  membership the residencies never recorded is more likely history than a
  mistake.
- **One person at a time**, each under the same lock a move or an import takes
  for that person. A move recorded while the check runs is either seen whole or
  waits for it.

Running it a second time finds nothing to append: the rows it wrote are what
the next run reads.

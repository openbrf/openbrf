# ADR 0017: Records that follow the apartment

Date: 2026-09-23

## Status

Accepted

Its account of the archive's documents in the portability export is amended by
[ADR 0018](0018-the-record-decides-what-the-export-carries.md).

## Context

A Swedish housing cooperative's lägenhetspärm is the binder about one
apartment: its drawings, the board's alteration permissions, records of what was
done and when, and manuals for what is installed. On paper it passes from
seller to buyer with the keys.

Nothing in the service tier works that way. Every resident-facing `mine` route
filters by the person who created the row - key orders, sublets, issues,
bookings - and the access report bounds an apartment's charges and fee notices
to the person's own residency dates so that it does not disclose the previous
household's. The one record that already follows the apartment is statutory: a
holder's own apartment register extract lists every earlier holder and every
transfer (BRL 9 kap. 11 §). An apartment binder would be the first service-tier
record that outlives one household and is read by the next.

Three things the platform has do not fit it.

**Media visibilities are groups.** `PUBLIC | INTERNAL | MEMBER` each name a set
of people the whole association agrees on. "The tenant-owners of 1201" is a
relation between a reader and a row, not a group, and `open()` reads neither an
uploader nor an apartment. A binder file stored `MEMBER` would be readable by
every member of the association, and one stored `INTERNAL` by every account.

**The document archive's audience is its whole access rule.** A fourth value on
`DocumentAudience` would need an apartment column beside it, the archive's
`list()` would carry every binder in the building onto the board's shelf, and
the website's document block would be a third place that had to keep agreeing.
The change is larger, not smaller.

**Every capability in the product is reachable through the administrator's
grant,** which is the whole capability list. That is the right default for
somebody the association appointed to run its instance. It is the wrong default
for the papers of one home: an administrator is whoever holds the server, and on
a hosted instance is not a member of the association at all.

What the statute asks of the record is narrow. BRL 7 kap. 7 § requires the
board's permission for an alteration i lägenheten and lets it attach conditions.
It has two triggers, not one: första stycket lists five kinds of measure, and
andra stycket requires permission "alltid" for a measure affecting an apartment's
särskilda historiska, kulturhistoriska, miljömässiga eller konstnärliga värden,
whichever of the five it falls outside. 7 kap. 12 a § lets the association remedy
an alteration made i strid med 7 § at the holder's cost; 7 kap. 18 § 9 makes an
alteration without behövligt tillstånd a ground of forfeiture, and names första
eller andra stycket alike. Each of those is asked about the apartment as it
stands, whoever made the change. What no section says is whether a permission, or
a condition attached to one, binds the next holder.

## Decision

### An apartment binder's entries belong to the apartment

One binder per apartment, and no personal half. Everything filed is about the
apartment and stays with it; a tenant-owner may take out what they themselves
filed for as long as they hold the apartment, and after that it stays. A store
for a member's own papers is not a purpose a housing cooperative has - BRL 1
kap. 1 § fixes the purpose as upplåta lägenheter med bostadsrätt - and it would
be a second answer to what the access report already gives a person about
themselves.

Nothing is written at a transfer. There is no job, no hook and no copy: access
is derived per request from the residencies, which is the board chat's shape.

### Access is a residency held on the association's day, both ends

`residencyHeldOn` (ADR 0014) decides it, in the binder service and again in the
media service. The move-in date is the first day held and the move-out date the
first day not held, compared as calendar days on the association's own calendar
(ADR 0013).

Both ends matter here in a way they do not everywhere. A move-in may be dated
ahead: the board records a buyer when it admits them, which is before tillträde.
Under the one-sided predicate the product used before ADR 0014, that buyer would
have read the seller's binder from the day the move was typed in, while the
seller still lived there and before the seller had taken out what was theirs.

### Two media visibilities, keyed on the file's own apartment

`TENANT_OWNERS` and `HOUSEHOLD`, decided in `MediaService.open` against a
residency on `MediaFile.apartmentId`. A CHECK ties the two columns together in
both directions, so there is no file readable by "this apartment's household"
that does not say which apartment, and no apartment on a file held any other
way.

They are added to the media layer rather than to the archive because the media
route is the one route in the product that streams a stored file, and the
serving branch is an allowlist with a refusing default - so a value added to the
schema is refused everywhere until the branch that handles it lands.

The household is asked before the capability, so a board member reading the
binder of the apartment they live in is served as a resident and is not recorded
as the board having read a household's papers.

### `apartmentBinder:manage` comes with a board seat and with nothing else

This is the first capability in the product that a grant of capabilities does
not carry. A board is elected by the general meeting and answerable to it; an
administrator is whoever holds the server. Reading a household's papers follows
the election.

It is expressed in the types rather than in a comment or a branch:

- `SEAT_BOUND_CAPABILITIES` names the capabilities a board seat alone confers.
- `GrantableCapability` is `Exclude<Capability, SeatBoundCapability>`, and the
  administrator's, member's, resident's and property manager's grants are
  declared as lists of it - so naming a seat-bound capability in any of them
  does not compile.
- The administrator's grant stays a derivation of the whole list rather than a
  list of its own: `CAPABILITIES.filter((c) => !isSeatBound(c))`. A capability
  added later is the administrator's without anybody remembering that line,
  which is what it has always been.
- The board's grant is built by spreading `SEAT_BOUND_CAPABILITIES` into it, so
  a capability declared seat-bound and left out of the board's list - one nobody
  in the product could hold - is not a state the file can be left in.

So neither direction can happen by accident. A capability added to
`CAPABILITIES` is grantable like every other one until somebody writes it into
the seat-bound list and says why here; and one written there cannot leak back
into a grant by being added to the wrong array.

There is no seat test inside a service, and no branch that asks which role the
caller holds. The withholding is the absence of the capability from a grant,
which is the same shape as `systemRole:manage` being absent from the board's:
the guarantee is the absence of a path rather than the correctness of a branch
inside one.

`documents:manage` is deliberately left as it is. What the board files in the
archive is the association's own record, addressed to the members, and an
administrator managing the archive is ordinary administration. A binder holds
the papers of one home.

### An entry is one PDF, and the board's permission is one of its kinds

Six kinds, a free-text title, a date where the kind has one, and an audience.
The kind carries behaviour - who may file it and which audience the form offers
first - and behaviour does not belong in a string the board types.

`ALTERATION_PERMISSION` is filed by the board alone and carries the day the
board decided, both held by a CHECK as well as by the service. It is one kind
for both of 7 § triggers: a board permitting work on a protected-value apartment
files the same entry as one permitting a stambyte, because what the binder
records is that the board decided, not which stycke made it necessary. What the binder
is worth to the next holder is that tillstånd means the board said so, and an
entry that claimed to be a decision of the board's while saying it was filed by
a tenant-owner is not a state the table may be left in.

The permission is stated and never enforced. Nothing reads an entry to decide
anything, and the platform says nothing about whether a condition binds the next
holder, because BRL does not.

Entries are filed and taken out and never edited. A wrong title or audience is
corrected by taking the entry out and filing it again: an audience edit would
widen who reads a household's papers without leaving a trace, and the archive's
own edit writes no audit entry at all.

### The filer is kept as a capacity and a detachable link

`filedAs` is `BOARD` or `TENANT_OWNER` and stays for good; `filedByPersonId` is
a plain column the service-data purge detaches on the filer's own retention
window, exactly as the archive's `uploadedByPersonId` is. A legal hold and an
art. 18 restriction therefore suspend it with no new code, and there is no new
cron.

A household is never shown who filed an entry - only whether it was the board or
a tenant-owner, and whether it was the reader themselves. One rule for every
household is simpler to keep true than a rule with an exception for people who
live together, and it is the rule that protects a tenant-owner with protected
personal data without a branch for them. The board's view names the filer
through the named-to-nobody shape the chat exports.

### Every board read of a binder is audited, and a household's is not

Two entries, because the board reaches a binder two ways.

`APARTMENT_BINDER_READ` records the board being answered one apartment's
listing. The listing is the sensitive read and not only the file behind it: a
title states what was done in somebody's home - "Tillstand badrum anpassat for
rullstol" - which is the health category the art. 30 row declares, and it is
disclosed whether or not a file is then opened. Without it a board member could
walk every apartment's binder and leave no trace. The entry names the apartment
and how many entries were disclosed, and never a title. It is written by
`withAuditedRead`, so the answer and the entry commit together: a listing served
without its entry is the one outcome this cannot have. The count is filled in by
the read rather than counted beside it, because a second count could differ from
the listing by whatever was filed in between, and this row outlives everything
it describes.

`MEDIA_ACCESSED` records a serve by capability, before the bytes leave, as it
does for the board's shelf in the archive.

**The apartment chooser is deliberately not audited.** It answers apartment
designations and an entry count each and reads nobody's papers - the line
`registerReport:export` already draws around the queue of outstanding duties.
What is promised is that reading a binder is recorded, and that is what is
recorded.

A household reading its own binder writes nothing: its residency is the whole of
the rule, and a row per serve would be a permanent record of which resident
opened which of their own papers when. This is not the members' shelf, whose
serves are unlogged because members read the bylaws and the annual report as a
matter of course and would bury what the law needs; a board opening one home's
papers is rare and is precisely the accountable access.

### The log never holds a household's own words

`MEDIA_UPLOADED` leaves the file name out for a binder upload, and so does
`MEDIA_DELETED` for all three removal paths - the tenant-owner's take-out, the
board's, and the rollback when an entry cannot be written. Both are the same
`recordFileName: false`, which defaults to recording the name so that every
other caller of the media layer is unchanged. The log is append-only and exempt
from every purge, and a household's file name is its own words about its own
home - the rule the initial share capital's entry already states. Taking an
entry out is also how the board carries out an art. 17 request about one, so a
name recorded there would have put the erasure's own subject permanently beyond
reach. The name is still on the row and still served in the disposition.

### A filing is refused on what would be stored, not on what arrived

The title and the file name are both scanned for a personal identity number,
and the refusal names which field and where and never the value. The file name
is not decoration: it is stored on the row, answered in every household's
listing and echoed in the download disposition, so a number in it reaches the
next household exactly as a number in the title would.

**The file name is scanned after sanitising, and that order is the rule rather
than an implementation detail.** `safeFileName` strips the Unicode "other"
category and path punctuation before the name is written, and stripping a
character joins what it separated: `1981:1218-9876.pdf` carries no personal
identity number for the scanner and is stored as one, and a zero-width space
does the same through the other half of that expression. So the check runs on
the value that will be written. One scan and not two: sanitising only removes
characters, so any digit run that survives it was already in what arrived, and
scanning both would report offsets into two different strings. An offset in a
refusal points into the stored value, which is the string a reader would have
been shown.

The file's own contents cannot be scanned: nothing in the product reads a PDF's
text, and the form says so, which is the honest version of a guarantee the
platform cannot give.

## Consequences

The first service-tier record a later household reads. When the apartment
changes hands nothing happens at all: the next household reads the binder from
the day its residency begins and the last one stops on the day its residency
ends.

A board member reading one apartment's binder leaves a row per opening, which is
new traffic in the audit log. It is bounded by how often a board opens a home's
papers rather than by how many files a page shows, which is the distinction that
keeps it from burying anything.

An administrator who holds no seat cannot read a household's papers, cannot list
the binders and is answered 404 for a binder file - including whoever operates a
hosted instance. An association whose administrator needs to reach a binder
gives them a seat.

The binder's start bound is stricter than the principal's, on purpose. A
tenant-owner whose move-in is recorded for next month is a member to the
principal today and holds resident capabilities, and reads no binder. The
product's other current-residency checks still read the end alone in the places
ADR 0014 lists.

The old household's other residencies stay open. A move-out ends one residency
and leaves the co-holder and every `RESIDENT` row as they were, so a partner the
board forgets to move out keeps reading the household entries, the new
household's included. No code can close this, because only the board knows the
partner has gone. What the product does is make it visible: the board is shown
how many tenant-owners and how many other residents each binder reaches today. A
termination is the same case - it writes no residency at all.

Files are encrypted at rest, a binder's included, because every stored file is
(ADR 0015). The art. 30 row says so rather than the opposite, through the
storage-backed list the record composes its security sentence from.

The binder joins no erasure-domain registry. It registers no scheduled job that
reads granted erasure requests: the link is detached inside the service-data
run's own transaction, exactly as the archive's is.

The record of processing activities gains a row, `apartmentBinder`, on art.
6(1)(f) - the association's interest in knowing what was done in its house and
what it permitted (7 kap. 12 a §, 18 § 9), and the next holder's in receiving
the apartment's history. Its personal data categories name health, on the issue
row's precedent: the record of a bathroom adapted for a disability is health
data whether or not anybody meant it to be.

The access report lists what a person filed, as metadata, and not what others
filed about an apartment they lived in: no link the platform holds makes another
household's papers this person's data, which is how the report already reads
art. 15(4). The binder is not in the portability export, because art. 20(1)(a)
reaches consent and contract and this rests on legitimate interest. The
archive's documents rest on the same basis and are in the export anyway; this
change names that inconsistency and does not copy it.

A household's papers can name the household. A work record carries the holder's
name, and a protected tenant-owner's filing can carry theirs to the next
household. The platform cannot read a PDF; the form says what it cannot do and
that what is filed stays, and the board takes an entry out on request.

One residency count per binder file served, on the index the residency table
already carries, ahead of the stream it precedes.

One apartment per entry. A drawing that fits twelve apartments of one type is
filed twelve times, because one file cannot carry twelve households' visibility
on one row.

A binder is bounded at 256 MiB per apartment, counted from the stored byte sizes
on every filing. The number is chosen rather than found: without it one
household could fill the association's disk ten megabytes at a time.

## Revisit triggers

- **A cooperative asks for a personal half**, at which point the binder grows a
  retention clock of its own, a purge scan and a second art. 30 row.
- **A second feature needs a per-apartment file** - issue photographs are the
  candidate - at which point the two visibilities stop being the binder's and
  become the platform's.
- **A second capability is proposed as seat-bound.** One is an exception; a
  list of them is a second grant, and a grant belongs in `capabilitiesFor`
  rather than in a filter.
- **An application form for BRL 7 kap. 7 § is asked for**, which is the sublet
  form's shape and a box of its own.
- **Images or another format are wanted**, at which point the upload takes the
  identifiable-persons declaration the media layer requires.
- **`safeFileName` changes what it does to a name.** The scan is run on its
  output because it removes characters; a version that instead replaced or
  re-encoded them, or that ran anywhere but before the write, would make the
  order above wrong rather than merely redundant. The same question is worth
  asking of any guard the product grows: a check on text that is transformed
  before it is stored is a check on the wrong value, and the file name was the
  one place in this product where that was true.
- **The product moves its remaining current-residency checks to both ends**, at
  which point the binder's bound stops being stricter than the principal's.

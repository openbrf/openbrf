---
"@openbrf/api": minor
"@openbrf/i18n": minor
---

Add the notice (kallelse) that summons a general meeting, on a delivery ledger
of its own, and the link from a motion to the meeting that takes it up.

EFL 6 kap. 22 § is what makes a notice a notice rather than a message about a
meeting. It requires the time and the place; where the meeting is to be held
digitally, how the members are to take part and to vote; and the matters to be
dealt with, clearly stated. The first two are columns on the notice. The day is
not: it stays on the meeting, because it is the day that decides who has a vote,
so the notice carries the hour and is written only where that hour falls on the
meeting's own day. The participation instruction is one nullable column rather
than a flag beside a text, because that paragraph makes the instruction required
exactly when the meeting is digital - so the instruction being there and the
meeting being digital are one fact and not two that could disagree.

The matters are the meeting's agenda, and they are not copied onto the notice.
Issuing it freezes them instead. **That freeze is the load-bearing part of this
change.** EFL 6 kap. 15 § gives a member the right to have an item taken up _in
the notice_, and 6 kap. 25 § leaves the meeting unable to decide a matter the
notice did not take up without the consent of every member the failure affects.
So which items a meeting may deal with is settled by its notice: from the moment
one is issued the agenda cannot be rewritten, and no motion can be put to that
meeting or taken off it. Three refusals follow from the same paragraph. A
meeting with no agenda cannot be summoned, because a notice stating no matters
is not a notice. A meeting recorded as held cannot be summoned. And a meeting
already summoned is not summoned twice - the remedy 6 kap. 25 § gives for a
notice that went wrong is that the meeting may resolve to convene an extra
general meeting, which is a meeting of its own with a notice of its own, rather
than that a second notice repairs the first.

The fourth limb of 22 § has no column. Where an item concerns a change to the
bylaws the notice must state the main content of the proposal, and nothing here
records that an item is a bylaws change or holds the proposal, so the board
writes that content into the item as the notice states it.

**The ledger is the news delivery ledger's shape on a table of its own**, because
a notice is not a news item. One row per recipient, snapshotted inside the
transaction that issues the notice, with the triple of notice, person and channel
unique, and the worker claims each row conditionally from PENDING before it hands
anything to a mail server - so a retried job summons nobody twice. The channel
is an enum with one value and a default, which is the news ledger's own history
read forwards: its channel column carries a default so that rows written before
there was a second channel keep their meaning, and a column that starts with one
makes a second channel an added value rather than a backfill of rows nobody can
ask again. Post is deliberately not a value: EFL 6 kap. 21 § andra stycket
requires a letter in three cases, and this platform posts nothing and records
none of the facts those cases turn on.

A failure is recorded as a code and never in the mail server's own words, because
a rejection quotes the envelope back and the envelope is a member's address. It is
recorded on the row and never rolled back onto the notice: the meeting has been
summoned, and one address that did not work is a fact for the board to act on.

**A member the association holds no address for is written into the ledger and
failed, rather than left out of it.** That is deliberately the opposite of what
the news mailing does with a member it holds no telephone number for, and the
difference is what the two ledgers are for. A news mailing is an announcement,
and somebody it could not reach has missed something that is on the association's
website anyway. A notice is a summons the association owes each member (EFL 6
kap. 21 §), so a member this platform cannot reach is precisely what the board
has to be shown - because calling them is then the board's own job. The failure
carries a code of its own, so a member with no address is distinguishable from
one who has left the register.

Electronic notices are lawful for a housing cooperative: **BRL 1 kap. 10 §
applies the rules on information by electronic means in EFL 1 kap. 16 § to a
bostadsrattsforening sending kallelser.** That paragraph's first stycke attaches
three conditions - the general meeting has resolved on it, the association has
reliable routines for identifying the recipient together with reliable
information on how to reach them, and the recipient has consented. The second
stycke presumes the consent of a recipient who has not objected within a time
stated in a request sent by post, which must be at least two weeks from the day
the request was sent and must state that future information may be given by the
named electronic means unless they expressly object; the third lets a consent be
withdrawn at any time. Only the first of the three is association-wide: the
second is a routine rather than a record, and the third is per-recipient and
revocable. None of the three is a fact this platform decides, and none is
claimed: the ledger records that the association sent the notice, never that it
was entitled to, which is the same line the proxy authorisation draws between
the board seeing a signed document and the platform producing one. The time
within
which a notice is to be issued (EFL 6 kap. 17-18 §§) is stated and never
enforced, because both sections let the bylaws move the latest date and this
platform holds no such clause.

The message carries the notice in full - the kind of meeting, the time, the
place, the participation instruction where there is one, and every matter in its
running order - and offers no link and no button. That is the opposite of the
news mail, which carries a title and a link because the article lives on the
association's website. A notice has no such home: 22 § makes the content the
requirement, and a link to a page behind a sign-in is not a notice that has been
given.

**`Motion.meetingId` is the linkage the first tranche deliberately left out**,
nullable, and it lands here rather than with the meeting because the notice is
what decides which meeting takes an item up. It is refused once that meeting's
notice has been issued and once the meeting has been recorded as held, and the
refusal is checked against the meeting being left as well as the one being
joined: detaching an item a notice stated is the same failure as attaching one it
did not. A motion the member took back is refused on different ground - the right
in EFL 6 kap. 15 § is theirs to exercise and taking it back is theirs too. The
link is its own act with its own audit action, and the member who submitted the
motion stays the subject of the entry, so what the board did with their item is
answerable from their own data subject access report. Both views name the meeting
and its day rather than giving an identifier, because a member holds no
capability that would let them resolve one. A request that loses the race for
the link answers with a reason of its own rather than being told the motion is
closed: it is exactly as open as it was, and what the board has to do is read
the queue again.

**The freeze is held by an advisory lock on the meeting**
(`meetings/agenda-lock.ts`, keyed `meeting-agenda:<meetingId>`). Three writers
read whether a notice exists and then write on the answer - issuing the notice,
replacing the agenda, and linking a motion to a meeting or taking that link
back - and at READ COMMITTED being inside a transaction is not the guarantee: a
notice committing after the read and before the write is invisible to the
reader, and the write lands. The three touch different tables, so nothing in
the database refuses either outcome and both are silent. It is a second key
rather than the proxy lock's, because who may exercise a member's vote has no
bearing on which matters were summoned and one key for both would queue
unrelated board work. A move holds the keys of both meetings, sorted, so two
moves in opposite directions between one pair cannot deadlock. The unique key on
`MeetingNotice.meetingId` stays the last line of defence and its refusal is now
worded rather than escaping as a client error.

Neither ledger table appears in the data subject access report, on the news
delivery ledger's own precedent: what the report answers for is the meeting's
record - who was present, and the authority a vote was exercised under - and a
mailing ledger is the association's record of an act it performed.

Migrations `20260909100000_meeting_notice` and
`20260909110000_meeting_notice_audit_actions`.

---
"@openbrf/api": minor
"@openbrf/web": minor
"@openbrf/i18n": minor
---

Add the general meeting: the meeting itself, its agenda, who was present and in
what capacity, the written authorities somebody else's vote is exercised under,
and each item's outcome recorded as counts.

EFL 6 kap., which BRL 9 kap. 14 § applies to a housing cooperative with six
exceptions. Four of those six are the association's own bylaws clauses and the
other two are prohibitions, so both halves are settled here rather than left for
the screens: postal voting does not apply to a housing cooperative and the
meeting's powers may not be delegated to fullmaktige, and neither is built.

**The voting register is derived and never stored.** No vote count and no
eligibility flag exists on any row, exactly as a booking allowance is counted
out of the residencies at write time and for the same reason - a stored figure
goes stale the moment somebody moves or a transfer completes, and it goes stale
silently, because nothing about the row looks wrong. Every member has one vote
(EFL 6 kap. 3 §), so a member holding two apartments has one and not two: the
vote belongs to the membership and not to the holding, which the plan for this
module had backwards at first. Members holding one bostadsratt jointly have one
vote between them (BRL 9 kap. 14 § 1, and unconditional, unlike the storage
limitation in the same paragraph), so their memberships are one line - and a
member who shares one apartment with a second and another with a third is one
line with all three, because a member cannot have one vote with each of them
without having two. The line names every member and every apartment that went
into it, which is what lets a meeting change the register: EFL 6 kap. 27 § has
it drawn up by the chair, approved by the meeting, and standing until the
meeting resolves to change it.

Two sources, each for what it is the record of. Whether somebody was a member on
the meeting day comes from the member register (medlemsforteckning), which
bostadsrattslagen requires, which is append-only, and which can therefore still
answer for a meeting held years ago. Which bostadsratt a membership covers comes
from the residencies with the MEMBER role, the rows the apartment register
itself reads to list an apartment's holders - the archive cannot answer it,
because an EXIT row is written only when a person's last tenant-ownership ends,
so it leaves an open entry on an apartment somebody sold while keeping another,
and a merge keyed on that would put a seller and their buyer on one line with
one vote between them.

An assistant is on the register and carries no vote. EFL 6 kap. 7 § lets a
member or a proxy holder bring at most one, who may speak at the meeting, and
that is the whole of what it grants; EFL 6 kap. 27 § still lists them among
those present, so they are a line without a vote rather than an absence. The
database states the one-each rule as a constraint. A person can be on one
meeting's register twice - as a member and as a proxy holder, which is the
ordinary case for somebody arriving with a neighbour's proxy authorisation - so
the capacity belongs to the line and not to the person, and that person has two
votes and one body.

**A proxy authorisation is checked against the statute and the bylaws, and is
never signed here.** EFL 6 kap. 4 § holds an authority good for at most one year
from the day the member signed it, and that is asked again when the register is
drawn rather than trusted from the registration: the meeting day can be moved
afterwards. A member may not be represented by more than one proxy holder, which
is checked behind an advisory lock keyed on the meeting and the member: the rule
is over the authorisations standing at any moment, so no index can state it, and
a plain read before the write would let two board members naming different
holders each find none. Who may be a proxy holder is the member's spouse or
cohabitant or another member unless the bylaws say otherwise (BRL 9 kap. 14 §
4), and the ground the board relied on is recorded because only one of those
limbs is decidable: the register says who is a member, and nothing here records
who is anybody's spouse or cohabitant - so an authorisation resting on that is
the board's own statement, and refusing it would refuse what the statute permits
outright. What the row records is that the board saw the paper. It records no
signature and implies none: a document that has to be signed under that Act may
be signed with an advanced electronic signature (EFL 1 kap. 15 §), which is a
trust service the free core does not provide.

All four bylaws clauses sit with the instance settings, each defaulted to the
statutory position rather than to a blank - unlike the motion deadline, which
has no default because the statute supplies no rule where the bylaws are silent.
One member per proxy holder, and deliberately not the three EFL 6 kap. 5 §
allows an economic association generally: BRL 9 kap. 14 § 4 replaces that rule
for a housing cooperative, and an instance defaulted to three would let one
person arrive holding a block of votes the statute keeps out of a
bostadsrattsforening. Two of the four are checked when a proxy is registered and
two are stated for the board to apply in the room, and the line between them is
not a matter of effort: the platform enforces a clause exactly when it holds the
facts the clause turns on. It knows who is a member; it holds no record of who
is anybody's spouse and none of what a space in the building is used for, so the
storage-only voting limitation and the assistant rule are reported rather than
applied. An answer invented from a participation share would take somebody's
vote away on a guess.

The chair records each item's outcome and the counts, which is how EFL 6 kap. 39
§ has the minutes state an omrostning. The outcome is recorded and not computed
from the counts, and that is the statute rather than a shortcut: an ordinary
question carries on more than half the votes cast with a casting vote on a tie,
an election goes to whoever got the most votes, and a change of the bylaws falls
under BRL 9 kap. 23 § and 24 § forsta stycket instead - which rule an item falls
under is a fact about the item that nothing here holds. Abstentions are counted
and belong to no majority. Corrected in place with the audit log carrying what
it moved to, because what stands is the signed protokoll: EFL 6 kap. 39-40 §§
leave that document with the association, filed in its archive, which is what
the motion module already says of a meeting's lasting record.

A vote record arrives with no voter recorded and nothing writes into it. A
closed ballot (sluten omrostning) is lawful on request and is the ordinary way
an election is held, so it is a vote with no voter, and adding that column later
would mean migrating a table the association's minutes are built from. Real-time
voting is separate work.

Same change, because this is the change that creates the tables: the data
subject access report carries a person's attendance at a general meeting and
every authority naming them. The proxy section answers for both roles - an
authorisation names the member who gave their vote away and the proxy holder who
carried it, which are two different facts about two different people - on the
pattern the audit log's own two person columns already set. Neither section
states an erasure date, and that is an answer rather than an omission: the
register is taken into or appended to the minutes and the minutes are kept, so
these two sit with the statutory register sections, kept because the law
requires the record and printed because exemption from erasure has never been
exemption from access. The other person on an authorisation or beside an
assistant is an identifier and never a name, which is what art. 15(4) forces on
a document the association hands over.

The board's screens, the notice, the link from a motion to the meeting it is
taken up at and the end-to-end suite follow separately.

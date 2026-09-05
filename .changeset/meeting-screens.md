---
"@openbrf/web": minor
"@openbrf/i18n": minor
---

Add the board's screens for a general meeting: arranging one, its agenda and its
notice, registering a proxy authorisation, checking people in, reading the voting
register and minuting what was decided.

The whole module has been on the server since the two changes before this one and
had no web surface at all. What this adds is that surface, on one destination
behind `meetings:manage`, plus the four bylaws clauses on the settings screen and
the control that puts a member's motion to a meeting.

**One reader, and every act discards its own answer.** The voting register
(röstlängd) is derived from the member register, the residencies, the attendance
lines and the standing authorities together, and every write on this module
answers with the one row it wrote - never with the register. So a check-in's
answer cannot say how many votes are now in the room, whether a proxy holder has
just been left with nothing to exercise because the member turned up, or whether
the person checked in is on the register at all. Only a read can. Every panel
therefore throws its write's return value away and asks the screen to read the
meeting again, and the screen is the only thing that reads - the pattern the
event sign-up panel already follows, for the same reason and with more riding on
it here. The re-read happens when an act is refused as well as when it lands,
because several of these refusals are about state the board has to look at next.

**The state of the meeting decides which panels are forms and which are records,
and both facts come from the server.** Issuing the notice fixes the agenda (EFL
6 kap. 22 § with 25 §) and recording the meeting as held closes check-in and the
authorities and opens the decisions. Each of those is rendered as a statement
saying which rule is holding rather than as a disabled form: one of the two is
answered by arranging another meeting and the other is not answered at all, and a
board that could not tell them apart would not know which.

**Five of this module's refusals are 403s and none of them is about a
permission.** A person who is not a member on the meeting day, a proxy holder who
is not another member, one the bylaws do not permit, one already carrying as many
members as they allow, and one holding no authority at all. The shared branch
answers every 403 with a sentence about what the account may do, which is right
for the guard and wrong for all five: each is a statement about BRL 9 kap. 14 §
or about the association's own stadgar, and a board member at a door told their
account is not allowed would go looking for somebody to grant them something. So
the module's own map is consulted first and each refusal names its rule. That map
is checked with `satisfies` against the reason union, so a reason the server
gains and the client has no sentence for is a compile error rather than a wrong
sentence at a meeting. The motions module's map is given the same treatment and
gains the four reasons it was silently missing.

**The bylaws are stated where they will be applied.** Two of the four clauses are
checked by the server, because the platform holds membership; the other two are
reported, because it holds no record of who is anybody's spouse or cohabitant and
none of what a space in the building is used for. The proxy panel says which rule
is in force before anybody meets it, the check-in panel says the same about
assistants, and the settings panel says which two it checks - a switch that
looked like an enforcement would be read as one, and a board that stopped
applying the assistant rule itself would be applying nothing. None of these four
opens at a blank: every clause has a rule that applies unless the bylaws displace
it, so an association that has recorded nothing is under the statute rather than
half-configured, and the proxy limit opens at the housing cooperative's one
rather than the general Act's three.

**Nothing here casts a vote or counts one.** The decision form takes three
figures because an ordinary majority is measured against the votes cast and what
a decision needed is the chair's to state. The counts are not checked against the
votes present either: a count above that figure is possible on a register the
meeting itself resolved to change, which is exactly what EFL 6 kap. 27 § allows.
A closed ballot (sluten omröstning) is recorded and never required - the word
does not occur in lagen om ekonomiska föreningar at all, so it is the meeting's
own procedure rather than a right anybody may demand.

**The meetings API answers with identifiers and never with names**, which is
deliberate on its side: a second store of who somebody is would be a second thing
to keep true. The screens read the address book for the names, which is the same
data through the same capability - `meetings:manage` and `addressBook:read` are
held by the same seat - and print the identifier itself where the register no
longer holds the person, because a board reading an empty space cannot tell that
from a screen that failed to load. The picker offers everybody the book holds and
never narrows itself to whoever it has decided is a member: who may be checked in
is a question about the member register as of the meeting day, the server answers
it, and a screen that answered from today's residencies would be a second opinion
on the statute formed from the wrong day.

The end-to-end suite drives all of it through a browser against the production
image, on a fixture that moves its own members in - a residency says somebody
lives here and only the member register says who may vote, which is the
distinction the module rests on. It covers the register drawn from that register,
somebody who is not a member refused at check-in with the rule named, an
authority putting an absent member's vote in the room only once the proxy holder
is checked in as one, the association's own proxy limit refusing a second
authority and accepting it once an administrator has widened it, the notice
taking the agenda's form away, a motion put to a meeting reaching the member who
submitted it, and a decision refused until the meeting has been recorded as held
and then minuted with the counts the chair declared.

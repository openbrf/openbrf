---
"@openbrf/api": minor
"@openbrf/web": minor
"@openbrf/i18n": minor
---

Add news: what the board writes to the house, and the news mailing that goes
out at most once.

A news item is the association's own writing - a headline, an address under
`/nyheter`, and text in paragraphs with subheadings. It is written as a draft
that nobody can read, and publishing it is a separate act in which the board
also says who it is for. Members only unless it says otherwise: a notice about
the laundry room is written for the people who live in the house, and putting
one on the street is a second, deliberate answer. A member-only item is served
to anyone signed in and answered to everybody else with the same not-found
document, byte for byte, that an address with nothing behind it gets - so a
visitor with no account cannot learn that the association has written anything
there at all.

Publishing offers to email the members, on by default, and no member is ever
written to twice. The offer is made once and then it is gone: publishing claims
the news mailing in the same transaction that writes down who it is for, one
row per member with the pair held unique, and the worker claims each of those
rows again before it hands a message to a mail server. Editing a published item
does not touch any of it, so correcting a spelling mistake in a notice cannot
put that notice in anybody's mailbox a second time - not because anyone
remembered to check, but because the ordinary save writes three columns and
none of them is the one that decides. Two board members publishing at the same
moment produce one mailing between them, and a job retried after a restart
carries on with the rows it had not yet claimed. Claiming before the send is
what makes a second copy impossible, and the cost is the other way round: a
worker lost between the claim and the mail server takes that one recipient's
copy with it.

The recipients are the members, with an address to write to. Not every resident
is a member, and the mailing follows the tenant-ownership rather than the front
door. Who they are is taken as they stand at the moment of publication and
never revisited: somebody who moves in next week is not sent last week's news,
and somebody who moves out between the publication and the send still receives
it, because that list is the record of who the board was addressing. Each
person is written to in their own language, and the address is decrypted where
the message is composed - never carried in a job.

Reading public news needs no account and no capability. A member-only item is
readable by anyone signed in, and answered to everyone else with the same
not-found document an address with nothing behind it gets - so the news follows
the rule the pages already do. The index and each article are the same plain
server-rendered documents every other page is: one inline stylesheet, no
script, nothing fetched from anybody else, and no cookie set - a signed-in
reader's session travels with the request, and nothing here adds to it or
refreshes it. A page can carry the latest items as a teaser block, and what
that shows follows its reader - the public items for a visitor, the members' as
well for anyone signed in - so the same page reads correctly for both without
the stored page knowing who either of them is.

The menu can now point at it. The news index was already one of the generated
destinations the menu editor offers, held back from the rendered menu while
nothing served that address; it is served now, so an entry pointing at it is
shown. The entry is the same for everybody, because which items the index
lists is the index's own question: a visitor with no account is answered with
what anybody may read, never with a refusal and never with a count of the
items they may not.

The publication guardrails apply here as they do to a page. A personal identity
number refuses the publication and says which block and which position it is
in, never the number itself, and a body may hold text and nothing else: a news
item is an announcement, not a page layout. Publishing one in a public notice
would put a personnummer in front of anybody who found the address - a
personuppgiftsincident the association would have to assess and, in the
ordinary case, report to Integritetsskyddsmyndigheten within 72 hours. That is
why the guard sits in the write path rather than in whoever is proof-reading.
Every publication and every news mailing is written to the audit log in the
same transaction as the change it records. Where an instance has no mail
server, the item is published all the same and the board's screen says exactly
that - what failed was the post, not the notice.

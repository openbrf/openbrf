---
"@openbrf/api": minor
"@openbrf/web": minor
"@openbrf/i18n": minor
---

Add comments on news items: the residents' side of a notice, and what becomes
of what they wrote.

A comment is one resident's reply under one news item, written and read inside
the application. Residents and the board hold `news:comment`; the external
property manager does not, on the same footing as reporting an issue - they
handle the association's issues and do not live in the building. The
conversation is flat: one list of comments under one notice, and no threads
within threads, no reactions and no mentions. A full discussion forum is
deliberately never built, because a cooperative that wants one is better served
by software built for it than by a second-rate copy inside this one.

Visibility is inherited rather than decided again. A comment is exactly as
visible as the news item it sits on, so a draft has no thread at all and the
refusal for a draft is the refusal for an item that was never written - a
resident cannot walk the identifiers to learn what the board is working on. No
comment is rendered on the public website, and a comment on a public notice is
still not public: those pages take no authenticated writes and read no session
at all, so a thread there would be either anonymous or a login wall on a page
that promises neither. The reads and the writes are application endpoints, and
the module graph is what holds it - nothing under the website's own directory
can reach the service.

The board can strike a comment through and cannot erase one. Hiding writes the
date and the person who decided it, and nothing clears either: the comment stays
in the thread for every reader, its author is still named, and only its text is
withheld - readable to the board and to whoever wrote it. A board able to make a
comment disappear would leave nobody reading the thread afterwards able to tell
which had happened. Moderation is the `site:manage` the board already holds for
publishing in the cooperative's name, rather than a second capability with an
identical grant list. Both acts are written to the audit log in the same
transaction as the change, the hide recorded against the person it was done to.

A personal identity number refuses the comment, naming the position in the text
and never the number. This is the first place the guardrail protects a member
from themselves rather than the association from its board: elsewhere the person
writing is the person publishing, while here somebody pastes a neighbour's
details into a reply about a dispute, and the refusal is what stops the whole
house reading it. A comment is capped in length and each person has a budget of
comments per ten minutes, counted from what they actually wrote so that it
survives a restart and is the same budget in every process. No CAPTCHA, here or
anywhere in this product.

A comment carries the person who wrote it, so it arrives with its retention.
Every comment is on the data subject access report with its text in full - a
moderated one included, because a person is entitled to read the words the board
took off the thread - beside whether it is hidden and the earliest date the
purge can reach it. A nightly job erases comments a year after they were
written, on their own clock rather than the one that governs a former resident:
a comment's purpose ends with the conversation it belongs to, whether or not
whoever wrote it still lives here. A legal hold standing against the author
stops that, and stops it inside the eligibility query as well as inside the
deleting transaction, so held people can neither be erased nor fill a run with
work that cannot be done. An author with protected personal data is named to
nobody, the board included.

The screen that renders a thread is not in this change.

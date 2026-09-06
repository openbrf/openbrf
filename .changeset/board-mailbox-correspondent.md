---
"@openbrf/api": patch
---

Report a board mailbox thread to the person it was established to be with,
rather than to whoever holds the address today.

The data subject access report gathered somebody's correspondence with the board
by indexing their current email address and taking every thread that matched.
Nothing in the schema makes that an identification: a person's address index
carries no unique constraint, and a thread records an address and no period over
which it belonged to anybody. So the match answered "whoever holds this address
now". Two ordinary situations gave the wrong answer. Two residents of one
apartment who give the association the same address each received the other's
letters to the board, and the board's replies about them. And an address later
recorded for somebody else - a `styrelsen@` or `ordforande@` seat changing hands
is the everyday case - put the previous holder's correspondence into the new
holder's report. The document the association produces to demonstrate it handles
personal data properly was the one disclosing.

The identification is now the board mailbox's to make, and it is made once, as
the letter arrives: a thread records the person the register then held that
address for, and only where it held it for exactly one person. The report asks
for the threads carrying that link. A thread nobody was established to be - an
address the register does not hold, one a household shares, or one collected
before this release - is in no report, which is the answer that discloses
nothing rather than the one that guesses.

The legal hold still matches on the address, deliberately. Holding a thread that
turns out to be somebody else's keeps data past its window; releasing one that
should have been kept destroys evidence the association undertook to preserve,
and nothing recovers that.

The art. 20 portability export is unaffected: it is an allow-list of named
sections and board mailbox threads were never among them.

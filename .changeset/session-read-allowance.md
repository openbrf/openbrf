---
"@openbrf/api": patch
---

Give the session read a budget of its own, so a signed-in board member is not
returned to the sign-in form part-way through an afternoon.

**One budget was doing two jobs.** Better Auth counts its endpoints per client
address and per path, and this instance set one default for all of them: twenty
requests, and the count clears only after a whole window in which that address
asked for nothing on that path. On a credential path that shape is right, because
the caller it bounds is a script that never stops. On the session read it is the
wrong shape entirely, and the session read is the path the interface asks most:
a route guard reads the session before every guarded screen renders, the client's
session store reads it again when a page loads, and it reads it once more each
time the window regains focus. None of that is a rate the application sets, and a
person with two tabs open produces two of those streams. So about a dozen guarded
navigations spent the twenty, the next read was answered 429, and the client
cannot tell a refusal from having no session - the screen went to the sign-in
form while the session behind it was still valid.

The session read now has a budget of its own: two hundred inside a window of ten
seconds. Wider because the two paths ask different questions - a sign-in is a
guess at a credential and worth counting tightly, while a session read presents
the cookie the browser already holds and answers with the session or with null,
so there is nothing in it to guess and a budget on it changes what an attacker
gains by nothing at all. What it does bound is the cost of the read, which is two
indexed lookups. Ten seconds rather than sixty because of how the count clears: a
person who leaves a screen alone for ten seconds hands the budget back, where a
minute-long window means an interface in continuous use never gets one back.

**Nothing that guards a credential moved.** The rule is written for one exact
path and no pattern, and every path where guessing is the attack keeps the
tighter rule it already had: three attempts per ten seconds on sign-in, sign-up
and changing a password or an address, three per ten on the second factor, five a
minute on the two the sign-in link uses. Three tests hold that line - one over
HTTP asserting the sign-in path is refused inside fewer attempts than the general
budget allows, one asserting the session read is still bounded and by how much,
and one on the configuration asserting it names the session read and nothing
else.

**And the screenshot walk stops working around it.** The walk paced itself to
stay clear of the shared budget, counting every auth request one client made
against a single allowance of twenty and waiting where a person never would. It
was measured at its most demanding stretch: twenty-nine session reads by the
administrator with no ten-second pause among them, against the twenty the
session read used to have - so the pacing was load-bearing, and against the
session read's own two hundred it no longer is. The walk photographs its sixty
screens in both modes without waiting, and in place of the pacing it watches for
the refusal itself: a 429 on any auth endpoint now fails the walk naming the path
and the screen, rather than surfacing screens later as a control that is not on
the sign-in form.

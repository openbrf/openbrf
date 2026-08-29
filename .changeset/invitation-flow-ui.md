---
"@openbrf/api": minor
"@openbrf/web": minor
"@openbrf/i18n": minor
---

Add the invitation flow to the interface: inviting from the person view, and
activating from the link in the email.

The person view now carries the action that follows from the account state it
already showed. A person the register holds an address for is invited with one
button. A person with an invitation outstanding shows the date the link stops
working and is offered a new one - a lost email is the ordinary reason an
invitation goes unanswered, and sending a new one supersedes the old link rather
than leaving two of them alive. A person the register has no address for is told
that, instead of being offered a button that could only fail, and an instance
whose email settings were never filled in is told which settings are missing
rather than that the invitation was refused.

The link in the invitation email opens a screen. It asks for a password and
nothing else: everything else about the person is already in the register, and
the token in the link is what says which person this is. A successful activation
leaves them signed in on the register, with no second trip through a sign-in
form. That session comes from an ordinary password sign-in rather than from the
activation endpoint minting one, so the rate limiting, the cookie settings and
the second-factor policy apply exactly as they do to every other sign-in. What
makes it possible is that a successful activation answers with the address the
account was created for - disclosed only to a caller holding a valid, unused
token that was mailed to that very address. Every refusal still answers with a
reason and nothing else.

Each refusal is a sentence of its own, in the recipient's language. A link that
has already been used and an address that already has an account both say the
account exists and point at the sign-in screen; an expired invitation says to
ask the board for a new one; a link carrying no usable token says so before
asking for a password. An activation that succeeded but could not sign the
person in says the account is ready and sends them to sign in, because the
account exists either way and a second attempt would only meet a link that has
now been used.

The end-to-end suite drives all of it through a browser: the board invites two
people from the register, and each of them sets a password on the activation
screen and lands on the address book without visiting the sign-in form.

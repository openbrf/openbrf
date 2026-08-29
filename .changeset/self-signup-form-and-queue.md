---
"@openbrf/api": minor
"@openbrf/web": minor
"@openbrf/i18n": minor
---

Add the public request form and the board's review queue for self-signup.

Someone who lives in the cooperative but is not yet in the register asks for an
account at `/request-account`, reached from a link on the sign-in screen that
appears only while the board accepts requests. The form asks for a name, an
email address, an optional phone number, and the address and apartment number as
free text. There are no pickers on purpose: the screen is served before sign-in,
and a picker would tell anyone who loaded the page which addresses and
apartments the cooperative has. What the screen says after a submission is what
actually happened - no account and no entry in the register exist until a board
member approves the request, and a second request from the same email address
replaces the first rather than queueing twice. With the toggle off the screen carries a
closed notice instead of a form, and a form left open in a browser when the
board switches the toggle off turns into that same notice on its next
submission.

The board decides the requests in settings, beside the switch that produced
them. Each waiting request shows the applicant, their email address, the claim
exactly as it was typed, and the day it was made; the board picks the real
address and apartment beside it and approves, or turns the request away with an
optional reason. Approving creates the person, the residency and the invitation
in one step and sends the ordinary activation email; it never grants membership,
because holding a tenant-ownership is a matter of record rather than something
granted by asking. The refusals that mean something particular say so: a request
somebody else has already decided, one replaced by a newer one from the same
email address, an apartment that has left the register, and an approval that
committed
but could not send its invitation because the instance has no email server
configured.

A public `GET /api/signup-requests/state` endpoint answers whether the form is
open. It stands in its own controller with no capability on it, and discloses
nothing the submit endpoint did not already: that one refuses an anonymous
caller with the same fact before it reads anything else in the request.

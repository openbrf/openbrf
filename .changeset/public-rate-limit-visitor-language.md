---
"@openbrf/api": patch
"@openbrf/web": patch
"@openbrf/i18n": patch
---

A visitor who sends a form on the association's website too often in a minute
now gets a page in their own language that says to wait a moment and send it
again. Before, the browser showed the API's English refusal as raw JSON. The
same page answers every website address that limits how often one connection
may ask. The account request form, the invitation's activation screen, the
first administrator's step in the setup wizard and the support sign-in screen
now say the same thing and keep the form, where they used to show a general
error. The support sign-in screen used to say the link no longer works, and it
now offers to try again. API routes still answer with the code
`too-many-requests` and a `Retry-After` header.

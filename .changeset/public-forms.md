---
"@openbrf/api": minor
"@openbrf/web": minor
"@openbrf/i18n": minor
---

Put the contact form and the issue report form on the association's website, as
pages the board places them on.

Both are plain HTML. A form posts to the page it was read on, the answer is a
redirect back to that page, and the page shows a confirmation. Nothing runs in
the visitor's browser, nothing is stored there, and no response sets a cookie -
which means the forms work with scripting switched off, in every browser a
cooperative's neighbours actually use. The content policy the website is served
under gains one entry, `form-action 'self'`, which narrows it: a page on this
website can only ever send what somebody typed back to the instance they are
reading it on.

A message to the board is stored before anything is sent. The board is notified
by email afterwards, through the job queue and one message per recipient, so a
retry can never send anybody a second copy - and an instance whose email
settings are wrong keeps the message rather than losing it. The inbox in
settings is therefore the record and the email is a notification about it. It is
read by whoever decides sign-up requests, because that is the same board work:
the two queues an anonymous visitor can put something into.

A report from the public creates an issue under a type the association offers
non-members, and under no other: the identifier a submission names is checked
against the same filter that decided what to show, so a type that was never
offered is answered as if it did not exist. The report takes text and never a
file. Contact details are optional and encrypted at rest, and the description
carries the standing warning that health data and other people's details arrive
in free text without anybody intending it.

Whether the report form exists at all remains the board's switch. With it off,
the block renders as nothing and the endpoint answers byte for byte what an
address that names no page answers - so a page carrying the form survives the
switch being turned, and closing the form is not an edit to the page. The same
answer covers a form posted to a page that does not carry it and a form on a
page an anonymous visitor may not read, which is what keeps a submission from
being a way to find out which pages the association has.

Both forms sit behind the per-address budget and the decoy field the public
sign-up form already uses. A submission that fills the decoy is answered exactly
as a stored one is, and is read before the association's own settings are, so a
script learns nothing at all - not even whether this cooperative takes reports
from the public.

---
"@openbrf/web": patch
---

Keep what is typed in a form while it is being saved.

Many forms clear their fields once a save succeeds, but only disabled the submit
button while the request ran, so anything typed in the meantime was dropped
without a word. The forms now disable all their fields for the duration of the
request, so input is refused instead of lost. This covers the SMTP, SMS and
board mailbox settings (including the secret fields), apartments, addresses,
issue types, bookable resources, sublet applications, board mailbox replies,
document filing, binder entries, issue reports, motions, key orders, chat
messages and news comments.

Focus stays where it was: the field that had it when the form was sent gets it
back once the request ends, on success and on failure, and so does the submit
button when a browser (Safari, macOS Firefox) left it unfocused when pressed.
Focus is only given back while it is still in the form or on the page itself; a
control the user moved to in the meantime keeps it. The fee and charge forms
share the same locked form component.

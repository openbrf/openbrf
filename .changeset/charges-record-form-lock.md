---
"@openbrf/web": patch
---

Keep what is typed in the charge form while a charge is being recorded.

The amount and the reason are cleared once the charge is stored, but only the
submit button was disabled while the request ran, so anything typed in the
meantime was dropped without a word. The form's fields are now disabled for the
duration of the request, so input is refused instead of lost. Focus stays where
it was: a field that had it when the form was sent gets it back once the request
ends, and so does the submit button when a browser (Safari, macOS Firefox) left
it unfocused when pressed. Focus is only given back while it is still in the
form or on the page itself; a field the user moved to in the meantime keeps it.
The fee form shares the same focus hand-back.

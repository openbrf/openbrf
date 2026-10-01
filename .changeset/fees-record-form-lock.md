---
"@openbrf/web": patch
---

Keep what is typed in the fee record form while a rate is being recorded.

The monthly amount is cleared once the rate is stored, but only the submit
button was disabled while the request ran, so anything typed in the meantime was
dropped without a word. The form's fields are now disabled for the duration of
the request, so input is refused instead of lost. Focus stays where it was: a
field that had it when the form was sent gets it back once the request ends, and
when that was the submit button, the amount field does.

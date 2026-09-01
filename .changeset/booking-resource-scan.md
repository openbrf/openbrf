---
"@openbrf/api": minor
"@openbrf/web": minor
"@openbrf/i18n": minor
---

Refuse a bookable resource whose name or description carries a personal
identity number.

The two free-text fields on a resource are the board's own words, and they reach
further than the settings form they are typed on: every resident reads the name
and the description on the booking calendar, and the name goes into the
confirmation mail sent once a booking commits and the notice sent when somebody
else cancels one. A number pasted there is copied out to mailboxes the
association does not control, which is the one disclosure no later edit reaches.
A resource is also the longest-lived row in the module, withdrawn rather than
deleted and outside every purge scope, because the bookings made against it say
what they were for only through it.

There is no publication step to hang the scan on, unlike a news item or an event
series: a resource is on every resident's calendar from the moment it exists. So
both fields are scanned on the way in and on every later edit, on the one method
the two write paths share, and a resource that already exists is not a way round
the guard.

The refusal is its own reason code and names the fields it was found in, in the
words the form above them uses, and never the value. The response carries the
character offset as well because nothing else could report it, and the settings
panel declines to render it: a character position in a textarea is not something
a person acts on, and the field is.

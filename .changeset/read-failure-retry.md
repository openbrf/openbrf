---
"@openbrf/web": patch
"@openbrf/i18n": patch
---

Offer a way out of a screen whose first read failed.

Six screens answered a failed list read with a sentence ending "Reload the
page." and nothing else: the issues board, the bookings, the calendar, the
motions, the meetings and the plugin list. There was nothing to act on, because
the list never arrived and none of the controls that would have re-read it are
on the page until it does. Reloading is a browser action for what is usually a
moment's trouble on one request, and it throws away the route and any panel that
was open on the way there.

Each of those screens already had the read the retry needs - every one of them
re-reads after a write - so the control calls the screen's own read rather than
reloading anything. Which read that is stays the screen's decision: several
fetch more than one thing and answer as a whole, and a shared control that
guessed would repeat the wrong request.

The address book has offered a button on a failed load since it was built. This
is that answer everywhere else, in one component, and the six sentences drop
their "Reload the page." half because a control now stands where that
instruction did.

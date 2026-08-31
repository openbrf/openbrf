---
"@openbrf/api": minor
"@openbrf/web": minor
---

Cover resource booking end to end against the production image, and give
whoever runs the calendar an endpoint that serves the catalogue of what the
house offers.

The suite drives a browser through the five properties of the module that only
exist once the interface, the API, the association's clock and a real database
are in the same room. A resident takes a laundry hour and the calendar then
states the hour as theirs rather than as somebody's. A second household loses
the race for the same hour: the first booking lands while the second reader's
page is open, the database refuses the second claim through its partial unique
index, and the screen turns that code into the one sentence that says both what
happened and that the calendar has moved on. The allowance is the apartment's,
so a second person living there is refused although they hold nothing of their
own. The board cancels on somebody else's behalf from the half of the screen its
capability opens, that half names the household holding the hour, and the hour
is back on the calendar afterwards. The external property manager has no
bookings entry in the navigation and no panel on the screen behind it.

Every date the suite books on is computed from the day the run happens, because
the API refuses a slot that has begun and a date written into a file stops being
in the future.

The catalogue of what the house offers is now also served from the board's own
base path. It was reachable only behind `bookings:book` and behind
`bookings:configure`, so a principal holding `bookings:manage` alone - which no
seat grants today and one may - had no endpoint for a list its own screen needs
in order to name a resource. A second route rather than one route serving both
audiences, because the capabilities a route declares are read together: naming
both halves of the house on one of them would demand both and refuse each
audience the other's capability. What the new route answers is the same summary
the resident calendar is given, with no booking count and no withdrawn resource
on it, and there is no write route beside it - so the configuration surface stays
where it was.

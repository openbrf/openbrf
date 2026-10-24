# @openbrf/display

## 0.1.0

### Minor Changes

- 78b27c4: Publish `@openbrf/display`, what every screen showing an association's content
  is built from (ADR 0050). The core's display mode and the digital signage
  module's player use all four of its parts, so a screen shows the same thing
  whether it was opened on a display link or paired through the module:

  - **The screen content contract**: the `ScreenContent` document, version 1, as
    types and limits, and `parseScreenContent`, which reads a document by the
    player's rules. A field it does not know is ignored, a slide of a kind it
    does not know is skipped, and a document of another version is refused.
  - **The rotation builder**: `buildRotation` turns the news items, occurrences,
    meeting notices and bookable resources a caller read, and the moment of the
    fetch, into the news, events, meeting and availability slides, with every
    text shortened to its limit. `availabilityWindow` gives the free/busy window,
    to the end of the next day in the association's time zone.
  - **The renderer**: `mountRenderer` shows a document on an element, with each
    slide's time on screen, the schedule, the clock band, the orientation, the
    light or dark theme and every body kind, in Swedish or English. An
    availability slide tells only what its window covers: a day the window ends
    inside is shown with the hours it covers, never as free for the rest of the
    day. Every text from the document is shown as plain text, and none of it is
    cut off: a slide the screen cannot hold whole is shown a page at a time, each
    page for the slide's time on screen. A list goes as many items to a page as fit whole, a
    page still too tall is set smaller, and a text too tall even then continues on
    the next page, broken between two words, or a word longer than a page between
    two of its characters. It fetches nothing: a picture comes from a function
    the caller hands it, so a device token is never in a picture's address.
  - **The fetch loop**: `startFetchLoop` asks for screen content with the device
    token in `Authorization` and no cookie, and acts on each answer as the
    contract says. A refused token wipes the cached content and stops. A 404,
    the route switched off, wipes the cached content too and calls the caller's
    `onPaused`, or `onDisconnected` at once when it gives none, and the loop asks
    again every 60 seconds. Any other failure shows the last content for at most 24
    hours, with a note saying when it was fetched, and then says the screen is not
    connected.

  The package uses no framework and is licensed AGPL-3.0-only with the Open BRF
  Module Exception.

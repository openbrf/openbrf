# @openbrf/display

What every screen showing a housing cooperative's content is built from, in
[Open BRF](https://github.com/openbrf/openbrf): the screen content contract,
the rotation builder, the renderer and the fetch loop. The core's display mode
(a browser opened on a display link) and the digital signage module's player
both use all four, so a screen shows the association's news, events, the
notice of the next general meeting and free/busy availability the same way
whichever of them it runs.

It uses no framework and no DOM library, and has one dependency,
[`@openbrf/tokens`](https://www.npmjs.com/package/@openbrf/tokens), for the
default theme's colours.

## Installing

```sh
npm install @openbrf/display
```

## The four parts

1. **The screen content contract.** The `ScreenContent` document, version 1,
   as types (`ScreenContent`, `Slide`, the body kinds), its limits
   (`SCREEN_CONTENT_LIMITS`, `SLIDE_ID_PATTERN`), and `parseScreenContent`,
   which reads a document by the player's rules: unknown fields are ignored,
   a slide of an unknown or malformed kind is skipped, and an unknown
   `version` is refused with a `ScreenContentError`.
2. **The rotation builder.** `buildRotation` turns the news items,
   occurrences, meeting notices, bookable resources and busy intervals a
   caller has read, and the moment of the fetch, into the `news`, `events`,
   `meeting` and `availability` slides. It reads nothing on its own.
   `availabilityWindow` gives the window an availability slide covers: from
   the minute of the fetch to the end of the next day in the association's
   time zone.
3. **The renderer.** `mountRenderer` shows a document on an element: the
   rotation with each slide's `seconds` and `until`, the schedule, the clock
   band, the orientation, the theme and every body kind, in Swedish or
   English. It fetches nothing; a picture comes from a function you hand it.
   It adds its stylesheet (`DISPLAY_STYLESHEET`, every class prefixed
   `obrf-display`) to the document once.
4. **The fetch loop.** `startFetchLoop` asks for screen content with a device
   token and acts on each answer: 200 and 304 show content, a 401 with
   `realm="device"` and `device-token-invalid` forgets it and stops, 404
   pauses, 429 waits, and anything else shows the last content for at most
   24 hours. Where the content is cached is yours to choose.

## Usage

```ts
import { mountRenderer, startFetchLoop } from "@openbrf/display";

const renderer = mountRenderer(document.getElementById("screen")!, {
  // Fetch the picture with the token in a header, never in its URL.
  picture: async (ref) => {
    const response = await fetch(
      new URL(`pictures/${encodeURIComponent(ref.mediaFileId)}`, contentUrl),
      { headers: { Authorization: `Bearer ${token}` }, credentials: "omit" },
    );
    return response.ok ? URL.createObjectURL(await response.blob()) : null;
  },
  releasePicture: (url) => URL.revokeObjectURL(url),
});
renderer.message("loading", "sv");

startFetchLoop({
  url: contentUrl,
  token: () => localStorage.getItem("token"),
  cache: {
    read: () => JSON.parse(localStorage.getItem("content") ?? "null"),
    write: (entry) => localStorage.setItem("content", JSON.stringify(entry)),
    clear: () => localStorage.removeItem("content"),
  },
  onContent: (content, status) => renderer.show(content, status),
  onRevoked: () => {
    localStorage.removeItem("token");
    renderer.message("link-invalid", "sv");
  },
  onPaused: () => renderer.message("paused", "sv"),
  onDisconnected: () => renderer.message("not-connected", "sv"),
});
```

Give the element a size, such as the whole viewport: the canvas fills it and
is turned by the document's orientation.

## Versions

The package carries version 1 of the screen content contract. A field or a
body kind may be added within version 1, and an older renderer ignores what it
does not know. A change an older renderer would misread raises the contract's
version, which is served beside version 1, and the package then carries both.

## Documentation

- [The screen content contract](https://github.com/openbrf/openbrf/blob/main/docs/screen-content-contract.md)
- [ADR 0050: the display mode, and one renderer for every screen](https://github.com/openbrf/openbrf/blob/main/docs/adr/0050-the-display-mode-and-one-renderer-for-every-screen.md)
- [ADR 0034: digital signage on the public plugin API](https://github.com/openbrf/openbrf/blob/main/docs/adr/0034-digital-signage-on-the-public-plugin-api.md)

## Licence

AGPL-3.0-only, with the
[Open BRF Module Exception](https://github.com/openbrf/openbrf/blob/main/LICENSE-EXCEPTION.md).
A player or shell built on this package is a module under that exception and
may be licensed on any terms. Both texts are in the package.

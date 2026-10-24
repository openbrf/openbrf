# ADR 0050: The display mode, and one renderer for every screen

Date: 2026-10-20

## Status

Accepted. Answers the revisit trigger of
[ADR 0034](0034-digital-signage-on-the-public-plugin-api.md) for the core
display mode, and amends 0034 in three places: the screen content contract is
the core's, the board's pick of news items and events is a mark the core keeps,
and the player is built from the core's renderer. Builds on
[ADR 0031](0031-a-device-token-for-a-plugin-s-own-routes.md) and
[ADR 0032](0032-read-only-content-for-plugins.md).

## Context

The open core boundary splits digital signage in two (GOVERNANCE.md, "The open
core boundary"; ROADMAP.md, "Display mode for screens" and "Digital signage").
The read-only view on a screen - the news, the event calendar, the notice of the
next general meeting and whether the laundry room is free - is free and in the
core, so that a self-hoster can open it in a kiosk browser. What surrounds the
screen is the paid module, under clause (a): pairing a screen through Apteo's
pairing service, configuring a paired screen from the instance, and unattended
updates of its player. The ROADMAP line puts it in one phrase: the module is
paid for what surrounds the screen, not for the view itself.

ADR 0034 decided the module and left the display mode to its own design, with
one question for that design: whether the display mode and the module's player
share one renderer and one screen content route, so that the route moves into
the core and the plugin keeps pairing, configuration and releases, or whether
the two stay separate renderers of the same core reads. Nothing of the display
mode is built yet, and the module is not built either, so the answer costs
nothing to change now and a great deal once both exist.

Two renderers would be two views of the same news item, one free and one paid,
kept in step by nobody in particular. The module's would be the one with a
product behind it, and the free one would fall behind: the boundary would then be
kept in its wording and lost in what a board sees on the wall.

## Decision

### Words

| Swedish         | English             | Meaning                                                                                                                                         |
| --------------- | ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| visningsläge    | **display mode**    | The core's read-only view for a screen, opened in a browser with a display link. Free, in the core, and never carrying personal data.           |
| visningslänk    | **display link**    | The address a board member opens on a screen to show the display mode: the instance's display page, `/app/display`, with a device token for it. |
| visa på skärmar | **show on screens** | The board's mark on a news item or an event that it may be shown on a screen in the building. Off until the board sets it.                      |

A screen (skärm) is any display in the building that shows screen content
(skärminnehåll), whether paired through the module or opened on a display link.
The terms are in GLOSSARY.md.

### One document, one builder, one renderer

A new package, `@openbrf/display`, is published from this repository beside
`@openbrf/plugin-sdk` and `@openbrf/theme-tools`, under the core's licence. It
holds four things, and both the core's display mode and the module's player use
all four:

1. **The screen content contract.** The `ScreenContent` document, version 1,
   exactly as ADR 0034 defines it, as types and as a parser that applies the
   player's rules: open objects, an unknown `body.kind` skipped, an unknown
   `version` refused. The contract's text moves from ADR 0034 to
   `docs/screen-content-contract.md`, and from now on a change to it is a change
   to the core, under the same version rules.
2. **The rotation builder.** A function from the reads of ADR 0032 - news items,
   occurrences, meeting notices, bookable resources and their busy intervals,
   each as the plugin API types them - and the moment of the fetch to the
   `news`, `events`, `meeting` and `availability` slides. It reads nothing on its
   own, so whatever calls it decides what goes in, and what the core's route and
   the module's route give it comes through the same narrowed reads, the
   register check of ADR 0032 included.
3. **The renderer.** It mounts on an element and shows a `ScreenContent`
   document: the rotation, each slide's `seconds` and `until`, the schedule, the
   clock band, the orientation and the theme, and every body kind the contract
   names, the addon kinds included. It takes a document and nothing else, and
   fetches nothing: a picture comes from a function its caller hands it, so that
   a device token never has to be in a picture's URL. Its own words, such as
   "Coming events", are in `@openbrf/i18n` in Swedish and English and are built
   into the package.
4. **The fetch loop.** The request for screen content and what is done with each
   answer, as the table under "Pairing" in ADR 0034 says it for the instance's
   answers: 200 and 304, 401 with `realm="device"` and `device-token-invalid`,
   404, 429, and anything else. Where the content is cached and what a 401 wipes
   is handed to it, because a shell holds more than the display page does.

The package uses no framework, so that a shell loading the player from verified
files carries nothing the web application chose for itself.

### Two routes

The document has two routes, one in the core and one in the plugin, and they do
not merge:

- **The core's display route** at `/api/display/` serves the display mode. It
  builds its rotation from the published content the board marked for screens,
  and from nothing else. It calls no extension point and no plugin, so no path
  leads from it to the register or to an addon, and "the display mode carries no
  personal data" is a property of the route and not of anybody's configuration.
- **The plugin's device route** at `/api/plugin/signage/screen/` serves paired
  screens, as ADR 0034 decides. It builds the same four kinds of slide with the
  same builder, and adds what only the module has: each screen's configuration
  from the instance, the pictures the board chose, and the slides of the addons
  switched on for the screen.

One route in the core would need the core to hold each paired screen's
configuration and to call the addons at `source`. The first is the remote
configuration the boundary makes paid, and the second would put a path from the
register into the core's own route. The parts that decide what the screen looks
like and which published content it shows are shared; the parts that are the
module's stay in the plugin.

### The core's display route

The route answers as a device route does (ADR 0031), with one difference: it is
the core's, not a plugin's. GLOSSARY.md widens the two terms of ADR 0031 to
match: a device route is a plugin's or the core's `display` route, and a device
token is for one of them.

- **The token is a device token for the core's `display` route.** It is the same
  kind of token, in the same table, with no plugin, and the guard's device-route
  branch checks it as it checks a plugin's: only `GET` and `HEAD`, only
  `Authorization: Bearer`, the same 401 with `WWW-Authenticate: Bearer
realm="device"` and `device-token-invalid`, the same rate limit, the same CORS
  headers and `cache-control: no-store`. A board member holding `site:manage`
  issues it, on the core's display screen, and it is listed on the core's devices
  screen with the plugins' tokens, under "Display mode", where any of them can
  revoke it. Issuing and revoking are `DEVICE_TOKEN_ISSUED` and
  `DEVICE_TOKEN_REVOKED` with no plugin. A token for the core route is refused on
  every plugin's device route, and a plugin's on the core's.
- **`GET content`** answers 200 with a `ScreenContent` document and a strong
  `ETag`, or 304 to `If-None-Match`, as ADR 0034 says for the plugin's. Its query
  carries the screen's options (below); a value it does not know is 400
  `display-options-invalid`. The document's `screenId` is the token's id,
  `refreshSeconds` is 60, `releaseChannel` is `stable` and is read by no one,
  and the schedule is empty, so the screen shows the rotation all day.
- **`GET pictures/{mediaFileId}`** answers as the plugin's does: the picture
  when the current document refers to it and `media:read` would open it (ADR
  0032), 404 otherwise.

**What the rotation holds**, in this order, each source only when the screen's
options ask for it:

- **News**: the published news items marked "show on screens", newest first, at
  most ten, a slide each, with its first picture that `media:read` would open.
- **Events**: one slide with the soonest eight occurrences, not yet ended, of
  published events marked "show on screens", starting within 31 days.
- **Meeting**: the notice of the soonest general meeting that has been called and
  not yet held, one slide, until it starts. A notice is posted in the stairwell
  under most bylaws already; it carries no mark of its own.
- **Availability**: one slide with the chosen bookable resources, at most twelve,
  busy from the minute of the fetch to the end of the next day in the
  association's time zone.

Every read goes through the narrowed reads a plugin with a device route gets
(ADR 0032), so an item whose text names somebody in the register, or an
apartment number, is absent from the display mode as it is from every device,
and no busy interval that ended before the fetch is in it. The display mode
shows no `picture` slide and no `addon` slide.

### Show on screens

The board marks a news item, or an event with all its occurrences, "show on
screens" in the core's own editors, where it publishes it. The mark is off on
every item until the board sets it, and on no item created before this change.
The editor says beside it that an item for a screen must name nobody - no
resident, no neighbour, no contractor - and shows the withheld-from-devices
warning of ADR 0032 there. Setting or clearing it is part of the item's own
change and its audit entry. A members' item may be marked: the board is the one
that knows where its screens hang.

ADR 0034 rejected such a field because the core could not know what a plugin
would use an item for. The core now has a use of its own for it, the display
mode, and the mark says what it says for every screen: this item may hang on a
wall in the building. The mark therefore replaces the module's own pick (below).

### Configured at the screen

How one screen shows the content is in its display link, and changes only when
somebody opens a different link on it:

```
https://brf.example.se/app/display?sources=news,events,availability&resources=…&orientation=90#obrf_dt_…
```

| Option        | Values                                             | Default                               |
| ------------- | -------------------------------------------------- | ------------------------------------- |
| `sources`     | any of `news`, `events`, `meeting`, `availability` | all four                              |
| `resources`   | bookable resource ids, at most twelve              | every open resource, the first twelve |
| `orientation` | `0`, `90`, `180`, `270`                            | `0`                                   |
| `header`      | `none`, `clock`                                    | `clock`                               |
| `theme`       | `light`, `dark`                                    | `dark`                                |
| `locale`      | `sv`, `en`                                         | the instance's default language       |

The display screen in the core issues the token and composes the link from these
choices, and shows the link once, with a QR code, for the board member to open
on the screen. It does not keep the choices: the screen's link is where they are.

This is the line between the display mode and the module's remote configuration.
Whatever the board decides on the instance about content - which items are
marked, which meeting is called, which resources are open - reaches every screen
within a minute. Whatever is decided about one screen - its layout, its sources,
its schedule, its addons - is decided at the screen in the display mode, and from
the instance only through the module.

### The display page

`/display` is a page of the web application outside its signed-in frame. The
instance serves the application under `/app`, so the page's public address, and
the one a display link names, is `/app/display`; `/display` at the root of the
address is the public website's. The page reads the token from the fragment,
keeps it in the browser's `localStorage`, and takes the fragment out of the
address with `history.replaceState`. A fragment is never
sent to the server, so the token is in no request log. The page sends its query,
unchanged, as the query of its content request, sends the token in
`Authorization` and no cookie, and hands the answer to the renderer.

What it does with each answer is the fetch loop's: on a 401 it forgets the token
and its cached content and says that the display link is no longer valid, with
nothing from the instance; on any answer but 200, 304 and 401 it goes on showing
the last content for at most 24 hours since it was fetched, with a note saying
when, and then says that it is not connected. The core route never answers 404
to a token it accepts, because the display mode cannot be switched off apart
from its tokens.

### What changes in ADR 0034

- **The screen content contract is the core's.** The plugin and the player hold
  to it exactly, as before; the contract is in `docs/screen-content-contract.md`
  and in `@openbrf/display`.
- **The plugin keeps no pick.** It shows the news items and events marked "show
  on screens", which the host reads carry as `onScreens` on `PluginNewsItem` and
  `PluginOccurrence`, and builds their slides with the core's builder. Its
  records lose the picked items; the screen records, the pictures the board
  chose, the addons switched on and the account key stay. The base module's
  acceptance test is unchanged.
- **The player is the core's renderer and fetch loop**, with the module's own
  code around them for the shell. A player release is a renderer the pairing
  service delivers to paired screens, signed as ADR 0034 says; the display page
  always runs the renderer of the instance it is on.

Everything else in ADR 0034 stands: the module alone pairs a screen through the
pairing service, configures a paired screen from the instance, releases the
player, and declares the `source` extension point. A paired screen's shell is the
only one that holds a key, a `screenSecret` or a release floor.

### What is tested

The acceptance test the board accepted for the base module (ADR 0034, "The base
module shows no personal data") is run against the core's display route as well:
with residents in the register whose names, email addresses, phone numbers and
apartment numbers appear in news items and events marked "show on screens", in a
meeting agenda and in the name of a bookable resource, the display route's
content holds no name, no apartment number, no other field taken from the
register, and no busy interval that ended before the fetch. The renderer and the
fetch loop are tested in the package, so that a player built from them inherits
the tests rather than repeating them.

## Consequences

- The display mode and every paired screen show the association's content with
  the same code. A board that stops paying for the module loses pairing, remote
  configuration and new players; what it sees on the wall stays the same, from a
  display link.
- The module has nothing of its own between the instance's content and the wall
  but the screen's configuration and its addons. That is what the boundary says
  it is paid for, and a change to the view is a change to the core.
- `@openbrf/display` is a published interface with its own versions and
  changelog, and the player depends on a released version of it. A screen whose
  player is older than its instance shows what its renderer knows; the contract's
  rules for an older player are what make that safe.
- The core gains a display screen under `site:manage`, a display page at
  `/app/display`, a display route, an `onScreens` field on news items and event
  series, and a device token with no plugin. The devices screen of ADR 0031 lists it.
- The register check of ADR 0032 runs on the core's display route as well as on
  plugins with a device route. A board writing an item for its screens hears
  about a neighbour's surname from the editor in both cases.
- Whether the module's own code around the renderer is published as source is
  Apteo's decision about the module and not this record's. The renderer it is
  built from is published either way.

## Rejected alternatives

- **One screen content route in the core, for the display mode and paired
  screens alike.** The core would hold each paired screen's configuration,
  which is the module's paid part, and call the addons at `source` from its own
  route, which is a path from the register into the core's display.
- **Two renderers of the same reads.** Two views to keep in step, one of them
  with a product behind it; the free one would be the one that fell behind.
- **Paired screens loading the instance's display page.** It would end signed
  player releases, which are what keep code an instance did not ship off a TV,
  and the shell's storage and the TV's interfaces would be open to whatever the
  instance served.
- **The display mode on the public website, with no token.** Members' news, the
  meeting notice and the laundry room's busy times would be readable by anyone
  with the address.
- **The token in the query string of the display link.** Query strings are
  written into request logs (ADR 0031). The fragment is not sent at all.
- **Each display token carrying its options on the instance.** That is a screen
  configured from the instance without going to it: the module's remote
  configuration, in the core.
- **No mark, and every published item on the screens.** The register check
  cannot catch a name the register does not hold or a description that points at
  somebody (ADR 0032), and the board's mark is the second check ADR 0034 relies
  on.

## Revisit triggers

- **A screen needs a picture of its own**, such as a poster the board stores for
  the stairwell: a `picture` source in the display mode, with its own mark.
- **A board wants several screens changed at once without visiting them**, on
  the display mode: that is the module's remote configuration, and the answer is
  the module or a new decision about the boundary, not an option here.
- **The screen content contract needs version 2**: it is served at a path of its
  own beside version 1 on both routes, and the package carries both.

# The screen content contract

What the instance serves a screen (skärm) in the building, and how a screen
reads it. Two routes serve it and one package reads it:

- **the core's display route**, `/api/display/`, which serves the display mode
  (visningsläge) to a browser opened on a display link (visningslänk), and
- **a plugin's device route**, such as the digital signage module's
  `/api/plugin/signage/screen/`, which serves the screens paired to the
  instance through it;
- **`@openbrf/display`**, the published package that holds this contract as
  types and a parser, the builder of the rotation, the renderer and the fetch
  loop. The display page and the signage module's player are both built from
  it.

Both routes and every player hold to this contract exactly. It is the core's:
a change to it is a change to the core, under the version rules below
([ADR 0050](adr/0050-the-display-mode-and-one-renderer-for-every-screen.md),
which moved it here from
[ADR 0034](adr/0034-digital-signage-on-the-public-plugin-api.md)).

**Contract version: 1**

## The two requests

Both routes are device routes
([ADR 0031](adr/0031-a-device-token-for-a-plugin-s-own-routes.md)): each
request carries a device token (enhetstoken) for that route in
`Authorization: Bearer`, and nothing in the URL. A route answers `GET` and
`HEAD` only, refuses every token it does not accept with the same 401 and
`WWW-Authenticate: Bearer realm="device"` and the reason
`device-token-invalid`, limits calls per token with a 429 and `Retry-After`,
and sends `Access-Control-Allow-Origin: *`, `cache-control: no-store` and the
exposed `ETag`, `Retry-After` and `WWW-Authenticate` on every answer, its
refusals included. A token for the core's display route is refused on every
plugin's device route, and a plugin's on the core's.

**`GET content`** answers 200 with `application/json; charset=utf-8`, a strong
`ETag`, and the document below. Asked with `If-None-Match` and that tag, it
answers 304. The document is at most 1 MiB.

**`GET pictures/{mediaFileId}`** answers 200 with the picture's bytes, its
`Content-Type` and `ETag: "<version>"`, or 304 to `If-None-Match`. It answers
404 for a picture the current document does not refer to, and for one the
instance no longer opens. A player keys its cache on `mediaFileId` and
`version`, and fetches the URL `pictures/{mediaFileId}` resolved against the
content URL it was handed.

### On the core's display route

- The query of `GET content` carries the screen's options, the display link's
  own query, which the display page sends unchanged:

  | Option        | Values                                             | Default                               |
  | ------------- | -------------------------------------------------- | ------------------------------------- |
  | `sources`     | any of `news`, `events`, `meeting`, `availability` | all four                              |
  | `resources`   | bookable resource ids, at most twelve              | every open resource, the first twelve |
  | `orientation` | `0`, `90`, `180`, `270`                            | `0`                                   |
  | `header`      | `none`, `clock`                                    | `clock`                               |
  | `theme`       | `light`, `dark`                                    | `dark`                                |
  | `locale`      | `sv`, `en`                                         | the instance's default language       |

  A value the route does not know, or an option given twice, is 400
  `display-options-invalid`, naming the option in `options`. A
  parameter it does not know is ignored.

- `screenId` is the token's id, `refreshSeconds` is 60, `releaseChannel` is
  `stable` and read by no one, and `schedule.on` is empty, so the screen shows
  the rotation all day.
- The rotation holds, in this order and each only when `sources` asks for it:
  the published news items marked "show on screens", newest first, at most ten,
  a slide each; one slide with the soonest eight occurrences, not yet ended, of
  published events marked "show on screens", starting within 31 days; the
  notice of the soonest general meeting called and not yet held, until it
  starts; and one slide with the chosen bookable resources, busy from the
  minute of the fetch to the end of the next day in `timeZone`. Every read goes
  through the register check
  ([ADR 0032](adr/0032-read-only-content-for-plugins.md)), so an item that
  names somebody in the register, or an apartment number, is absent. The
  display mode shows no `picture` and no `addon` slide.
- It never answers 404 to a token it accepts, apart from a picture it does not
  show: the display mode cannot be switched off apart from its tokens.

### On a plugin's device route

What the signage module serves is decided in ADR 0034: each paired screen's
configuration from the instance, the pictures the board chose, and the slides
of the addons switched on for the screen, beside the same four kinds of slide
built with the same builder from the items marked "show on screens". A plugin
that is switched off or removed answers 404 on its device route.

## The document

```ts
type Instant = string; // RFC 3339 in UTC, whole seconds, "Z": "2026-12-01T09:00:00Z"
type LocalTime = string; // "HH:MM", "00:00" to "24:00", in the document's timeZone

interface ScreenContent {
  version: 1;
  screenId: string; // the screen's id: on the core's display route the device token's id, on a plugin's its subject
  generatedAt: Instant;
  refreshSeconds: number; // integer, 30 to 60
  locale: "sv" | "en";
  timeZone: string; // IANA zone of the association's calendar day (ADR 0013): "Europe/Stockholm"
  releaseChannel: "stable" | "beta"; // a paired screen's release channel; "stable" and read by no one on the display route
  layout: {
    orientation: 0 | 90 | 180 | 270; // degrees clockwise the player turns its canvas
    header: "none" | "clock"; // a band above the slides with the date and the time
    theme: "light" | "dark";
  };
  schedule: {
    // When the screen shows the rotation; outside every window it shows black.
    // Empty: always. At most 14. A window over midnight is two windows.
    on: {
      days: (1 | 2 | 3 | 4 | 5 | 6 | 7)[];
      from: LocalTime;
      to: LocalTime;
    }[]; // ISO weekdays, 1 is Monday; from < to
  };
  rotation: Slide[]; // in order, at most 100; the player loops through them
}

interface Slide {
  id: string; // 1 to 64 of A-Z a-z 0-9 . _ : -, the same on every fetch while the slide shows the same thing
  seconds: number; // integer, 5 to 120: how long it stays
  until: Instant | null; // the player skips the slide from this instant, without waiting for a fetch
  source: "news" | "events" | "meeting" | "availability" | "picture" | "addon";
  addon: string | null; // the addon's plugin id when source is "addon", otherwise null
  body:
    | NewsBody // source "news"
    | EventsBody // source "events"
    | MeetingBody // source "meeting"
    | AvailabilityBody // source "availability"
    | PictureBody // source "picture"
    | AddonBody; // source "addon": one slide of the source point's output, as above
}

interface NewsBody {
  kind: "news";
  title: string; // at most 200 characters
  paragraphs: string[]; // at most 2 000 characters together
  picture: PictureRef | null;
  publishedAt: Instant;
}

interface EventsBody {
  kind: "events";
  occurrences: {
    // 1 to 8, soonest first
    title: string; // at most 200 characters
    description: string | null; // at most 500 characters
    location: string | null; // at most 200 characters
    startsAt: Instant;
    endsAt: Instant;
    calledOff: boolean;
    placesLeft: number | null;
  }[];
}

interface MeetingBody {
  kind: "meeting";
  meetingKind: "ordinary" | "extraordinary";
  startsAt: Instant;
  place: string; // at most 200 characters
  digitalParticipation: string | null; // at most 500 characters
  agenda: { position: number; title: string }[]; // at most 40, titles at most 200 characters
}

interface AvailabilityBody {
  kind: "availability";
  from: Instant; // the fetch, to the minute; never earlier
  to: Instant; // at most 7 days after from
  resources: {
    // 1 to 12
    name: string; // at most 80 characters
    mode: "timeSlots" | "wholeDay" | "dateRange";
    slotMinutes: number | null;
    opensAtMinute: number | null; // minutes after midnight in timeZone
    closesAtMinute: number | null;
    busy: { start: Instant; end: Instant }[]; // merged, sorted, inside [from, to)
  }[];
}

interface PictureBody {
  kind: "picture";
  picture: PictureRef;
  caption: string | null; // at most 200 characters
}

type AddonBody =
  | { kind: "text"; heading: string; body: string[] }
  | { kind: "table"; heading: string; columns: string[]; rows: string[][] }
  | {
      kind: "doors";
      heading: string;
      doors: { floor: number | null; apartment: string; names: string[] }[];
    };

interface PictureRef {
  mediaFileId: string;
  contentType: string; // the image type the core identified from the bytes
  byteSize: number;
  version: string; // opaque, changes when the file does; the picture's ETag
  alt: string; // at most 300 characters
}
```

- **Every string is plain text.** A player never reads markup in it, and the
  route shortens a text that is over its limit, ending it with "…". Every
  heading and label the screen shows that is not in the document, such as
  "Coming events", is the player's own, in `locale`.
- **Every object is strict for the route and open for the player.** A route
  sends no field this contract does not name. A player ignores a field it does
  not know and skips a slide whose `body.kind` it does not know, so that a field
  or a kind added later in version 1 does not stop an older player.
- **Nothing a slide holds is cut off.** A screen that cannot show a slide
  whole - eight events, an agenda of forty items, a news item of fifty
  paragraphs - shows it a page at a time, each page for the slide's `seconds`:
  its list as many items to a page as fit whole, a page still too tall set
  smaller, and a text too tall even then continued on the next page, broken
  between two words, or a word longer than a page between two of its
  characters. The renderer in `@openbrf/display` does this.
- **A change reaches the screen within a minute.** A player fetches again
  `refreshSeconds` after each answer, and never more than 60 seconds after the
  last fetch whatever the document says, so a value above 60 from a route that
  breaks the contract cannot hold a screen to an old configuration.
- **The slides are built on each request** that is not answered 304, from the
  instance's content at the moment of the fetch. An addon that is not serving,
  fails or times out gives no slide, and the rest of the rotation is served
  without it.

## What a screen does with each answer

The fetch loop in `@openbrf/display` does this, and every player is built on
it. Where the content is cached, and what else a 401 wipes, is the player's:
the display page holds its token and the last content while it is open and
keeps them in `localStorage` across a reload, and a paired screen's shell keeps
more (ADR 0034, "Pairing").

| What the screen gets                                                                         | What it means                                         | What the player does                                                                                                                                                                   |
| -------------------------------------------------------------------------------------------- | ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET content`: 200 or 304                                                                    | The content, or no change.                            | Shows it, and replaces the cache whole on a 200.                                                                                                                                       |
| `GET content`: 401 with `WWW-Authenticate: Bearer realm="device"` and `device-token-invalid` | The token is revoked or unknown.                      | Forgets the content and the token, and says so: the display page that the display link is no longer valid, a paired screen by showing a new pairing code. Nothing from the instance.   |
| `GET content`: 404                                                                           | A plugin's route is switched off or removed: a pause. | Forgets the content, keeps the token, and asks again every 60 seconds.                                                                                                                 |
| `GET content`: 429                                                                           | Too many calls.                                       | Keeps what it shows and asks again after `Retry-After`, at most 60 seconds.                                                                                                            |
| `GET content`: any other answer, a network failure, or a document it cannot read             | The instance cannot be reached, or something between. | Keeps the last good content, with a small note saying when it was fetched, for at most 24 hours since then, and then shows that it is not connected and nothing else. Asks every 60 s. |
| `GET pictures/{id}`: anything but 200 or 304                                                 | The picture has gone, or cannot be fetched now.       | Shows its slide without the picture, or skips a picture slide. Changes nothing else.                                                                                                   |

## Versions

A change an older player would misread raises `version`, and the new version is
served at a path of its own beside this one on both routes, with
`@openbrf/display` carrying both, so screens that have not updated keep
working. A document with a `version` a player does not know is a failed fetch.
A field or a body kind added within version 1 is announced in the package's
changelog and in this file.

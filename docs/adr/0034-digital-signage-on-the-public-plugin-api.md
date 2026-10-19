# ADR 0034: Digital signage on the public plugin API

Date: 2026-10-19

## Status

Accepted. Builds on ADRs [0030](0030-plugins-that-extend-plugins.md),
[0031](0031-a-device-token-for-a-plugin-s-own-routes.md),
[0032](0032-read-only-content-for-plugins.md),
[0033](0033-a-plugin-s-own-records.md) and
[0035](0035-a-plugin-s-processing-and-objecting-to-it.md).

## Context

A housing cooperative puts a screen in the entrance, the stairwell or the
laundry room, and wants it to show the news, the event calendar, the notice of
the next general meeting and whether the laundry room is free. The board pairs
the screen to its instance once, decides what it shows from the instance, and
never has to touch the screen again. Some associations want more on it, such as
the residents of the entrance, which is what the board's own association shows
on its Samsung displays today.

Digital signage is a paid module (ROADMAP.md, "Paid modules"). All of it: the
plugin, the players, the hosted pairing and the updates. The core gets only the
general capabilities the module is built on, each its own decision and each
usable by any plugin author: extension points (0030), device tokens (0031),
read-only content (0032), a plugin's own records (0033), and a plugin's
declared processing with objections to it (0035). The module itself is
Apteo's and lives outside this repository.

This record is here because two of the module's parts touch every instance that
installs it, and an association running one is owed an account of both: what the
plugin on its instance sends to Apteo, and what the screens on its walls run.
It also fixes the interfaces between the module's parts, so that each can be
built and reviewed separately.

## Decision

### Words

The plan this record follows called the content route a "feed" and the hosted
service a "broker". Both are taken: the feed (flöde) is the residents' post
stream, and broker information (mäklarinfo) is the estate agents' page. The
module uses these instead, in code and in prose:

| Swedish            | English             | Meaning                                                                                                      |
| ------------------ | ------------------- | ------------------------------------------------------------------------------------------------------------ |
| skyltning          | **digital signage** | The module. Its plugin id is `signage`.                                                                      |
| skärm              | **screen**          | One display paired to an instance: a TV, a signage display, a kiosk browser.                                 |
| skärminnehåll      | **screen content**  | What the instance serves a screen: what to show, in what order, for how long.                                |
| källa              | **source**          | One kind of thing in a screen's rotation: news, events, a meeting notice, availability, a picture, an addon. |
| parkoppling        | **pairing**         | Binding a screen to an instance, once, by a code the screen shows.                                           |
| parkopplingstjänst | **pairing service** | Apteo's hosted service that pairs screens, holds the entitlement and serves the player releases.             |
| skal               | **shell**           | The part of a player installed on the screen: pairing, identity, diagnostics, and loading the player.        |
| spelare            | **player**          | The signed code the shell loads, which renders screen content.                                               |

An entrance is an address (`Address`), as everywhere in the core.

### The parts

1. **The `signage` plugin**, on the instance, built on the public plugin API only.
   It keeps the screens in its own records, serves screen content on a device
   route, declares the `source` extension point, and talks to the pairing
   service.
2. **The pairing service**, hosted by Apteo. It pairs a screen to an instance,
   holds the entitlement, and serves player releases. It holds no screen
   content, no configuration of what a screen shows, and nothing about the
   association's people.
3. **The shells**: a Samsung Tizen TV app, a Raspberry Pi image, and a hosted
   page for any kiosk browser. Each pairs, verifies and loads the player.
4. **The player**, one signed bundle for every shell, released through the
   pairing service.
5. **Addons**, plugins that extend `signage` at `source`. The first is Apteo's
   `signage-residents`.

The instance never connects to a screen. A screen fetches from the instance and
from the pairing service, so nothing needs a port opened towards a building's
network.

### The plugin

```jsonc
{
  "openbrf": {
    "apiVersion": 1,
    "id": "signage",
    "entry": {
      "server": "./dist/server.cjs",
      "client": "./dist/remoteEntry.js",
    },
    "permissions": [
      "news:read",
      "calendar:read",
      "bookings:readAvailability",
      "media:read",
      "addresses:read",
    ],
    "personalData": ["name", "apartment"],
    "processing": {
      "purpose": {
        "sv": "Visa på husets skärmar de namn och lägenheter som en utökning styrelsen slagit på för skärmen lämnar över.",
        "en": "Show on the building's screens the names and apartments an addon the board switched on for the screen hands over.",
      },
      "legalBasis": "legitimateInterest",
      "legitimateInterest": { "sv": "...", "en": "..." },
      "retention": {
        "sv": "Sparas inte på instansen. På skärmen till nästa hämtning, och i skärmens cache högst 24 timmar när instansen inte svarar.",
        "en": "Not stored on the instance. On the screen until the next fetch, and in the screen's cache for at most 24 hours while the instance does not answer.",
      },
      "dataSubjects": ["members", "residents"],
    },
    "view": { "module": "./View", "titleKey": "view.title" },
    "deviceRoutes": [{ "id": "screen", "path": "screen" }],
    "extensionPoints": [
      { "id": "source", "version": 1, "personalData": ["name", "apartment"] },
    ],
  },
}
```

The plugin reads nothing from the register (it may not, holding a device route).
What an addon hands it at `source` is the one way a name or an apartment reaches
a screen, and the plugin is the one that puts it there, so it declares both
categories and its processing of them (0030, 0035) and has its own row in the
record of processing activities beside the addon's. The board consents to the
flow twice: once to `signage` accepting names and apartments at `source`, and
once to the addon handing them over. An objection to either processing takes
the person off the screens.

**What it keeps** (0033): a record per screen - its id at the pairing service, the
board's label, where it hangs (inside the building, or visible from outside), the
address it hangs in or none, its layout and rotation, its schedule, its release
channel, and the addons switched on for it - the news items and events the board
has picked for screens, and one record holding the instance key for the pairing
service.

- **An addon shows on a screen only where the board has switched it on for that
  screen**, and it is off on every screen until then, including screens paired
  later. Installing the residents addon therefore puts no name on any wall until
  the board picks the screens. Each switch is an audit entry
  ([ADR 0035](0035-a-plugin-s-processing-and-objecting-to-it.md)).
- **A news item or an event reaches a screen only once the board has picked it**
  for screens, and none is picked by default. The choice is the plugin's rather
  than a field on the news item: the core cannot know which of a plugin's
  purposes an item is fit for, and the plugin can (ADR 0032). The picker says
  that an item for a screen must name nobody - no resident, no neighbour, no
  contractor - and lists only items the host gives the plugin, so an item naming
  somebody in the register is not offered at all.
- **The label is where the screen hangs**, such as "Entrance 3B", and the field
  says not to use a resident's name. It is shown to the board and is not sent
  to the screen.

**The base module shows no personal data.** Its sources are the news items and
events the board picked, occurrences with no sign-up names, meeting notices with
no attendance, busy intervals with no booker and nothing in the past, and
pictures declared to show no identifiable person. The host gives a plugin with a
device route no item whose text names somebody the register holds or an
apartment number, and no booking history (0032), and the board's pick is a
second check on what the host cannot recognise. The test is an acceptance
criterion of the module, as the plan the board accepted states it: with
residents in the register whose names, email addresses, phone numbers and
apartment numbers appear in news items and events picked for screens, in a
meeting agenda and in the name of a resource shown on the screen, the screen
content of a screen with no addon switched on holds no name, no apartment
number, no other field taken from the register, and no busy interval that ended
before the fetch.

### The `source` extension point, version 1

Input, as the host validates it:

```ts
{
  screen: {
    id: string; // the screen's id, opaque to the addon
    addressId: string | null; // the entrance the board says it hangs in
    placement: "inside" | "outside"; // visible from outside the building or not
    locale: "sv" | "en";
  }
}
```

Output: `{ slides: Slide[] }`, at most eight slides, each one of:

```ts
| { kind: "text"; heading: string; body: string[] }          // at most 2 000 characters
| { kind: "table"; heading: string; columns: string[];        // at most 4 columns
    rows: string[][] }                                         // at most 60 rows
| { kind: "doors"; heading: string;                           // at most 120 doors
    doors: { floor: number | null; apartment: string; names: string[] }[] }
```

Every string is plain text, and every object is strict, so an addon has nowhere
to put a field the screen would not show.

The residents addon answers with one `doors` slide for the screen's own entrance
and nothing else: the apartment number, the floor, and the names on the door,
read with `host.addressBook.residents({ addressId })` (ADR 0035). By default a
name is the family name, deduplicated and sorted per apartment, so the screen
shows households as a name board does; a first name is shown only for a person
with the `NAME_IN_BUILDING` publication consent. Never a role, a date, a person's
id or a contact detail. A person with protected personal data, a person under a
restriction and a person who has objected to the addon's processing are absent,
because the host leaves them out of the read. The addon answers with no slides
for a screen with no address, and refuses to be switched on for a screen whose
placement is `outside`.

### Screen content, version 1

The plugin and the player are built and released separately, so this is their
contract, and both hold to it exactly. The device route at
`/api/plugin/signage/screen/` answers two requests, each with the device token
in `Authorization` (0031).

**`GET content`** answers 200 with `application/json; charset=utf-8`, a strong
`ETag`, and the document below. Asked with `If-None-Match` and that tag, it
answers 304. The document is at most 1 MiB.

```ts
type Instant = string; // RFC 3339 in UTC, whole seconds, "Z": "2026-12-01T09:00:00Z"
type LocalTime = string; // "HH:MM", "00:00" to "24:00", in the document's timeZone

interface ScreenContent {
  version: 1;
  screenId: string; // the device token's subject: the screen's id at the pairing service
  generatedAt: Instant;
  refreshSeconds: number; // integer, 30 to 60; 60 unless the board shortened it
  locale: "sv" | "en";
  timeZone: string; // IANA zone of the association's calendar day (ADR 0013): "Europe/Stockholm"
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

- **Every string is plain text.** The player never reads markup in it, and the
  plugin shortens a text that is over its limit, ending it with "…". Every
  heading and label the screen shows that is not in the document, such as "Coming
  events", is the player's own, in `locale`.
- **Every object is strict for the plugin and open for the player.** The plugin
  sends no field this record does not name. A player ignores a field it does not
  know and skips a slide whose `body.kind` it does not know, so that a field or a
  kind added later in version 1 does not stop an older player. A change an older
  player would misread raises `version`, and the new version is served at a
  path of its own beside this one, so screens that have not updated keep
  working. A document with a `version` the player does not know is a failed
  fetch.
- **A change reaches the screen within a minute.** Everything the board sets
  for a screen is in this document, and the pairing service carries none of it,
  so the player's fetch is the only way a change arrives. The player fetches
  again `refreshSeconds` after each answer, and never more than 60 seconds
  after the last fetch whatever the document says, so a value above 60 from a
  plugin that breaks the contract cannot hold a screen to an old configuration.
- **The slides come from the plugin's own records and the host's reads**, built
  on each request that is not answered 304: the news items and events picked for
  screens, at most one meeting notice, the resources the board chose with their
  busy intervals from the moment of the fetch, the pictures the board chose, and
  the addons switched on for the screen. An addon that is not serving, fails or
  times out gives no slide, and the rest of the rotation is served without it.

**`GET pictures/{mediaFileId}`** answers 200 with the picture's bytes, its
`Content-Type` and `ETag: "<version>"`, or 304 to `If-None-Match`. It answers
404 for a picture the current document does not refer to, and for one the host
no longer opens. The player keys its cache on `mediaFileId` and `version`, and
fetches the URL `pictures/{mediaFileId}` resolved against the content URL it
was handed.

### Pairing

```
screen                      pairing service                  instance (signage)
  | POST /v1/screens  ------->|                                   |
  |<---- screenId, secret ----|                                   |
  | shows the pairing code    |                                   |
  |                           |<-------- POST /v1/pairings -------| board types the code
  |                           |------- screenId, public key ----->| checks the code
  |                           |                                   | issues a device token
  |                           |<- PUT /v1/screens/{id}/handover --| sealed to the screen
  | GET /v1/screen  --------->|                                   |
  |<-------- handover --------|                                   |
  | POST /v1/screen/handover-received                             |
  | opens it, then fetches screen content from the instance ------>|
```

1. **The screen registers.** The shell makes an ECDH P-256 key pair with WebCrypto
   (the private key is non-extractable and stays in the shell's storage) and
   calls `POST /v1/screens` with the public key and what it is: the shell's kind,
   version and level, and for a Samsung display its model and Unique ID. It gets
   back a `screenId` and a `screenSecret`, which authenticates it to the pairing
   service from then on.
2. **The code comes from the key.** The pairing code is the first 50 bits of the
   public key's JWK thumbprint (RFC 7638), written as ten characters of
   Crockford base32 in two groups (`7KQ3M-X2HDA`). The shell computes it from
   its own key and shows that; the pairing service never tells it which code to
   show. The service accepts the code for 15 minutes, until `pairingExpiresAt`,
   and then deletes the registration, and the shell registers again with a
   fresh key.
3. **The board types the code** into the plugin's admin screen. The plugin
   writes it in capitals without the hyphen or spaces, reading `I` and `L` as
   `1` and `O` as `0` as Crockford base32 does, calls `POST /v1/pairings`, gets
   the screen's id and public key, and computes the code from the key itself.
   A key that does not give the code the board typed is refused, and the plugin
   gives the screen back with `DELETE /v1/screens/{id}`. This is what stops the
   pairing service, or anyone who has taken it over, from putting a key of its
   own in place of the screen's: it would have to find a key whose thumbprint
   starts with the same 50 bits within the 15 minutes the code is valid.
4. **The instance issues the token and seals it.** The plugin issues a device
   token for the `screen` route with the screen's id as its subject (0031),
   encrypts the handover below to the screen's public key as a JWE, and puts it
   with `PUT /v1/screens/{id}/handover`.
5. **The screen collects it** from `GET /v1/screen`, opens it, checks it,
   confirms with `POST /v1/screen/handover-received`, and the pairing service
   deletes it. A screen claimed by `POST /v1/pairings` that has no handover
   within 15 minutes, and a handover not received within 15 minutes, are
   deleted, and the screen is `released`. A handover the shell cannot open, or
   whose `screenId` is not its own, is not confirmed: the shell wipes and
   registers again.

The handover, before it is sealed:

```ts
interface Handover {
  v: 1;
  screenId: string; // the screen's own id; the shell refuses another
  contentUrl: string; // absolute https URL of the content request:
  // "https://brf.example.se/api/plugin/signage/screen/content"
  token: string; // the device token, "obrf_dt_..."
  instance: {
    origin: string; // contentUrl's origin, shown on the screen's diagnostics
    name: string; // the association's name, at most 120 characters
  };
}
```

It is sealed as a JWE in compact serialization (RFC 7516), at most 8 KiB, with
the protected header `{ "alg": "ECDH-ES", "enc": "A256GCM", "epk": <the
ephemeral public key> }` and nothing else in it, over the UTF-8 bytes of the
JSON above. The shell refuses any other algorithm.

The pairing service therefore never holds a device token it can read, and the
protocol never tells it the instance's address.

**Unpairing.** The board unpairs a screen in the admin screen: the plugin revokes
its device token and calls `DELETE /v1/screens/{id}`. The board can also revoke
the token from the core's own screen (0031), which is enough on its own: the
next call from the screen is refused.

**What a screen does with each answer.** Only two answers unpair a screen: the
instance refusing its token, and the pairing service saying `released`. A
switched-off plugin is a pause, not an unpairing (0031), and a missing picture
is not about the pairing at all.

| What the screen gets                                                                         | What it means                                                       | What the shell does                                                                                                                                                                                                                         |
| -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET content`: 200 or 304                                                                    | The content, or no change.                                          | Shows it, and replaces the cache whole on a 200.                                                                                                                                                                                            |
| `GET content`: 401 with `WWW-Authenticate: Bearer realm="device"` and `device-token-invalid` | The token is revoked or unknown: the screen is not this instance's. | Wipes everything it holds - content, pictures, the token, its key, its `screenSecret` - and registers again, so it shows a new pairing code and nothing else.                                                                               |
| `GET content`: 404                                                                           | The plugin is switched off or removed: the screens are paused.      | Deletes the cached content and pictures, keeps the token, the key and the `screenSecret`, and shows that it is paused, with its own id and nothing from the instance. Asks again every 60 seconds, and shows content again on the next 200. |
| `GET content`: 429                                                                           | Too many calls.                                                     | Keeps what it shows and asks again after `Retry-After`, which the 60-second window keeps within a minute.                                                                                                                                   |
| `GET content`: any other answer, a network failure                                           | The instance cannot be reached, or something between is failing.    | Keeps the last good content, with a small note saying when it was fetched, for at most 24 hours since then, and then shows that it is not connected and nothing else. Asks again every 60 seconds meanwhile.                                |
| `GET pictures/{id}`: anything but 200 or 304                                                 | The picture has gone, or cannot be fetched now.                     | Shows its slide without the picture, or skips a picture slide. Changes nothing else.                                                                                                                                                        |
| `GET /v1/screen`: `released`                                                                 | The instance gave the screen back, or the pairing did not complete. | Wipes everything and registers again.                                                                                                                                                                                                       |
| `GET /v1/screen`: 401, or a failure, while paired                                            | The pairing service does not know the screen, or cannot be reached. | Goes on showing the instance's content, which the pairing service has no say over, gets no release until it is paired again, and says so in the diagnostics.                                                                                |

An unpaired screen shows its pairing code and its own details and nothing from
any instance. A screen whose plugin was removed stays paused, because a removed
plugin answers as a switched-off one does; the board resets it from the screen's
diagnostics panel, or releases it in Apteo's customer panel, and pairs it again.

### The pairing service API, version 1

The address of the service is the module's to choose, over HTTPS only. Every
request and answer body is `application/json` unless the table says otherwise,
and every object is strict: a request with a field the types below do not name
is refused. Every refusal is `{ "reason": "<code>" }` with its status, and these
three can come from any request:

| Status | `reason`              | When                                                                                 |
| ------ | --------------------- | ------------------------------------------------------------------------------------ |
| 400    | `request-invalid`     | The body does not match its type, a field the type does not name included.           |
| 401    | `credentials-invalid` | No bearer credential, or one the service does not know. It says nothing about which. |
| 429    | `rate-limited`        | Over the request's limit; `Retry-After` says when to ask again.                      |

What a screen tells the pairing service is limited to what the types below
name: the shell's kind, version and level, the release it runs, the display's
model and Unique ID, the outcome of a release, and its address as the network
shows it. No screenshot, no rendered content and no screen content ever passes
through it. The service keeps its request logs for at most 30 days and runs in
the EU/EEA.

```ts
type Instant = string; // as in the screen content
type PublicKey = { kty: "EC"; crv: "P-256"; x: string; y: string }; // a public JWK, exactly these members
type Shell = {
  kind: "tizen" | "raspberry-pi" | "web";
  version: string; // the shell's semantic version, "1.3.0"
  level: number; // integer from 1: what the shell offers a player, compared with a release's minShell
};
type Display = { model: string; uniqueId: string } | null; // a Samsung display's; each 1 to 64 printable ASCII characters
type Channel = "stable" | "beta";
```

**Who owns what.** A registration is the screen's: its `screenSecret` reaches
the `/v1/screen` requests and the releases, and nothing about any other screen.
A screen belongs to no instance until `POST /v1/pairings` answers for it, and
from then to the instance whose key asked, until it is released. Ownership is
the instance's, not the key's: a key replaced in the customer panel keeps the
instance's screens. An instance asking about a screen that is not its own gets
404 `screen-unknown`, the same as for a screen that does not exist. The service
stores the SHA-256 digest of each `screenSecret` and each instance key, never
the secret itself, and forgets a released screen once it has read `released`,
or 30 days after it was released.

**For a screen**, authenticated with `Authorization: Bearer <screenSecret>`
except for registering:

| Request                                              | Body             | Answer                                                                                                                    |
| ---------------------------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `POST /v1/screens`                                   | `RegisterScreen` | 201 `Registered`. 400 `public-key-invalid` for a key that is not a point on P-256. At most 10 an hour per client address. |
| `GET /v1/screen`                                     | -                | 200 `ScreenState`. A deleted registration is 401: the shell registers again.                                              |
| `POST /v1/screen/handover-received`                  | `{}`             | 204, and the handover is deleted. 404 `handover-unknown` when none is waiting.                                            |
| `POST /v1/screen/report`                             | `Report`         | 204. Sent when a release has started or has been reverted, for the staged rollout to read.                                |
| `GET /v1/releases/{channel}/{sequence}/manifest`     | -                | 200, the manifest's exact bytes as they were signed.                                                                      |
| `GET /v1/releases/{channel}/{sequence}/signature`    | -                | 200 `{ keyId, sig }`, the detached signature (below).                                                                     |
| `GET /v1/releases/{channel}/{sequence}/files/{path}` | -                | 200, the file's bytes, `application/octet-stream`. `{path}` is a manifest `path`, each segment percent-encoded.           |

The three release requests answer only a screen that is paired to an instance
with an active entitlement (402 `entitlement-required` otherwise), and only for
the release `GET /v1/screen` offers it or the one it reported started last (404
`release-unknown` otherwise). The service may answer a file request with a 302
to its storage; the shell follows it over HTTPS only, and trusts nothing it
fetched until the checks under "Releases and signing" pass.

```ts
interface RegisterScreen {
  publicKey: PublicKey;
  shell: Shell;
  display: Display;
}

interface Registered {
  screenId: string; // "scr_" and 26 characters of Crockford base32 (a ULID); also the device token's subject
  screenSecret: string; // 32 random bytes, base64url without padding
  pairingExpiresAt: Instant;
  pollSeconds: number;
}

interface ScreenState {
  state: "unpaired" | "paired" | "released"; // a screen claimed and not yet handed over is still "unpaired"
  pairingExpiresAt: Instant | null; // while unpaired
  handover: string | null; // the compact JWE, while one is waiting
  release: {
    // while paired to an instance with an active entitlement
    channel: Channel;
    sequence: number;
    version: string;
    minShell: number;
  } | null;
  pollSeconds: number; // 5 while unpaired, about 3 600 while paired
}

interface Report {
  channel: Channel;
  sequence: number;
  outcome: "started" | "reverted";
  shell: { version: string; level: number };
}
```

`released` means the instance gave the screen back: the shell wipes and
registers again. A screen polls as `pollSeconds` says, and asks the instance
for content on its own clock. A release whose `sequence` is not above the
highest the shell has accepted on its channel, or whose `minShell` is above its
level, is ignored.

**For an instance**, authenticated with `Authorization: Bearer <instance key>`:

| Request                         | Body              | Answer                                                                                                                                                                                                                                        |
| ------------------------------- | ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /v1/entitlement`           | -                 | 200 `{ status: "active" \| "lapsed" \| "none"; screensIncluded: number }`.                                                                                                                                                                    |
| `POST /v1/pairings`             | `{ pairingCode }` | 200 `PairingCandidate`, and the screen is claimed by the instance. 404 `pairing-code-unknown` (unknown or expired), 402 `entitlement-required`, 402 `screens-included-reached`, 409 `screen-already-paired`. At most 30 an hour per instance. |
| `PUT /v1/screens/{id}/handover` | `{ handover }`    | 204, and the screen is `paired`. Accepted while the screen is claimed, or paired with a handover not yet received, which it replaces. 409 `handover-already-received` after that.                                                             |
| `PUT /v1/screens/{id}/channel`  | `{ channel }`     | 204.                                                                                                                                                                                                                                          |
| `GET /v1/screens`               | -                 | 200 `{ screens: ScreenSummary[] }`, the instance's own, newest first.                                                                                                                                                                         |
| `DELETE /v1/screens/{id}`       | -                 | 204, and the screen is `released`. Answers 204 for a screen already released.                                                                                                                                                                 |

```ts
// pairingCode: the ten characters as the plugin normalised them, "7KQ3MX2HDA"
// handover: the compact JWE, at most 8 KiB

interface PairingCandidate {
  screenId: string;
  publicKey: PublicKey;
  shell: Shell;
  display: Display;
  registeredAt: Instant;
}

interface ScreenSummary {
  screenId: string;
  state: "claimed" | "paired" | "released";
  handover: "waiting" | "received" | null;
  channel: Channel;
  shell: Shell;
  display: Display;
  player: { sequence: number; version: string } | null; // the release it last reported started
  lastSeenAt: Instant | null;
}
```

The instance key is issued per instance in Apteo's customer panel and entered
once in the plugin's admin screen, which keeps it in the plugin's records (0033).
Installing the plugin makes no call to Apteo. The first is made when the board
enters the key, after a screen that says what will be sent, and every call is
made by the instance's server, never by the board member's browser.
It is worth little on its own: it can pair a screen only together with a code
shown on that screen, and the device token that gives a screen anything is
issued by the instance, not by the pairing service.

### Entitlement

The module does nothing without an Apteo entitlement, and the open code checks
no licence: a check in code anyone can read is a check anyone can remove.
Entitlement is enforced where Apteo's own infrastructure is needed:

- **Pairing** is refused without an active entitlement (`entitlement-required`).
- **Player releases** are served only to screens paired to an instance with an
  active entitlement.

An entitlement that lapses stops new pairings and new releases. Screens already
paired keep running the player they have and keep showing what the instance
serves them, because the instance's content route is the association's and the
module puts no check in it. The catalog listing says, before anything is
installed, that the module needs an Apteo account.

### Releases and signing

A release is a **player bundle** - the player's files - and a **release
manifest**:

```jsonc
{
  "format": 1,
  "product": "signage-player",
  "channel": "stable",
  "sequence": 42,
  "version": "1.4.2",
  "minShell": 1,
  "publishedAt": "2026-12-01T09:00:00Z",
  "entry": "player.js",
  "files": [{ "path": "player.js", "sha256": "<base64url>", "bytes": 48213 }],
}
```

| Field         | Meaning                                                                                                                                                                                                                                                                                                      |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `format`      | `1`. A shell refuses a manifest of a format it does not know.                                                                                                                                                                                                                                                |
| `product`     | `"signage-player"`.                                                                                                                                                                                                                                                                                          |
| `channel`     | `stable` or `beta`, and the same as the channel in the request path.                                                                                                                                                                                                                                         |
| `sequence`    | An integer from 1, the same as in the request path, rising on each channel.                                                                                                                                                                                                                                  |
| `version`     | The player's semantic version, shown in the diagnostics.                                                                                                                                                                                                                                                     |
| `minShell`    | The lowest shell level (`Shell.level`) that can run it.                                                                                                                                                                                                                                                      |
| `publishedAt` | An instant, as in the screen content.                                                                                                                                                                                                                                                                        |
| `entry`       | The `path` of the file the shell runs as a module script. It is one of `files`.                                                                                                                                                                                                                              |
| `files`       | 1 to 200 files. `path` is relative, `/`-separated, of `a-z 0-9 . _ -` segments, never `.` or `..`, ending `.js`, `.css`, `.json`, `.woff2`, `.png`, `.webp` or `.svg`, and unique. `sha256` is the digest of the file's bytes in base64url without padding, and `bytes` its length. At most 20 MiB together. |

The signature is served at `.../signature` as `{ keyId: string; sig: string }`:
`keyId` names one of the keys the shell pins, and `sig` is the base64url,
without padding, of the 64-byte signature.

A shell takes a release it is offered in this order, and drops it at the first
step that fails: it fetches the manifest and the signature, verifies the
signature over the manifest's bytes as they arrived, and only then parses them;
it checks `format`, `product`, `channel`, `sequence` and `minShell` against the
offer and against its own records; it fetches each file and checks its length
and digest; and it stores the release as verified only once every file has
passed. A release that fails is not reported, and the shell asks again on its
next poll.

- **The manifest is signed** with ECDSA P-256 and SHA-256 (`ES256`), in a
  detached signature holding `{ keyId, sig }`, the signature over the
  manifest's exact bytes in the IEEE P1363 form WebCrypto produces and verifies.
  ES256 rather than Ed25519 because the TVs run a Chromium whose WebCrypto has no
  Ed25519, and a shell that verifies with the platform's own primitive ships no
  cryptography of its own.
- **The shell pins the keys.** Each shell carries the public keys it accepts,
  at least two, so that a key can be retired by a shell update before it is
  needed. The private keys are held offline. The pairing service serves signed
  releases and holds no key that signs them, so taking over the pairing service
  is not enough to put code on a screen.
- **Every file is checked** against its digest in the signed manifest before the
  shell stores it, and the player runs only from the files that were checked.
- **The sequence only rises.** The shell records the highest sequence it has
  accepted on each channel and refuses a lower one. A rollback is a new release:
  the older files under a higher sequence.
- **Staged rollout is the pairing service's.** It decides which screens are
  offered a new release, a share at a time, and reads the `started` and
  `reverted` reports before widening it. The shell needs no rollout logic.
- **The shell reverts on its own.** It keeps the last two verified bundles. A
  player that has not told the shell it is running within two minutes of
  starting, or a shell that restarts three times in ten minutes without hearing
  it, goes back to the previous bundle, reports `reverted`, and stays there until
  a higher sequence arrives.

The signature protects screens whose shell is installed on the screen: the TV
app and the Raspberry Pi image. The hosted page for a kiosk browser is served by
Apteo, so a browser using it trusts Apteo's server for the shell as well, and the
signature adds nothing there that TLS does not.

### The Samsung Tizen shell

The board's own association runs a single-association app on Samsung signage
displays today, with its backend address built into the signed package. One
package cannot serve every association that way, because an instance's address is
known only after pairing. The TV app is therefore a **thin shell**: pairing,
identity, diagnostics, the cache and the verified loading of the player. All of
the player's logic comes from releases, and a new player needs no new package.

- **Access policy.** `config.xml` allows any origin (`<access origin="*"
subdomains="true"/>`), because the instance is known only at runtime, and the
  content security policy limits connections to `https:`. What may run is the
  shell and the signed player; what may be reached is anything over HTTPS, which
  is what an instance known only after pairing needs. CORS on the instance's side
  is settled by 0031: a device route answers any origin, so the packaged app's
  origin, which has not been observed on hardware, does not need to be known,
  and it exposes `WWW-Authenticate` on its 401, so a shell on any origin can
  tell a revoked token from a failure to connect.
- **The player runs in the shell's own document**, from `blob:` URLs made of the
  verified files, so that it has the same storage and the same `webapis` as the
  shell. It reaches the shell through one object, `window.signageShell`, for its
  version, the screen's id, `ready()` and the diagnostics.
- **Privileges: `internet` and `productinfo`.** The second reads the display's
  Unique ID, which the shell shows on the pairing screen and in the diagnostics
  and sends when it registers, so that the board can tell which display it is
  pairing. It is never used to authorise anything. Samsung's Unique ID is not the
  Unique Device ID that a standard distributor certificate lists, and the
  installation documentation names both.
- **Installed and updated through SSSP.** Each release channel has a root URL
  serving `sssp_config.xml` and the `.wgt`, and the display's own update flow
  picks up a higher `<ver>`. The shell changes rarely; the player changes through
  releases.
- **The package id is chosen once.** Installed displays refuse an update from
  another id or another author certificate, so both are fixed before the first
  display outside Apteo is installed, and the author certificate never changes.
- **The canvas fits the visual viewport**, falling back to the inner size, and
  refits when it changes: the QM43C reports an inner viewport larger than what it
  shows. Rotation by 90 or 270 degrees is a screen setting, not a URL parameter.
- **Nothing of Samsung's in the app.** The shell carries no analytics or
  advertising SDK. Whether the display's own viewing-information or
  content-recognition services can read what a web app renders is not known
  yet, so the installation guide tells the board to decline them when the
  display is set up and to switch them off afterwards. That question is open
  until it is answered on hardware, and if they can read the app's content, the
  residents addon will not be switched on for a Samsung display until the board
  confirms that they are off.
- **Diagnostics stay on the screen.** The remote's OK button opens a panel with
  the versions, the viewports, the scale, the screen's id, whether it is paused
  and the instance's host, never a token and never content, and nothing in it is
  sent anywhere. The panel's reset, held for five seconds, wipes the screen and
  registers it again, for a screen whose plugin was removed.

The standard Samsung certificate needs every display's Unique Device ID in the
distributor certificate, so each new display means a new certificate and a new
package. That works for the board's own displays and does not work for a sold
module. Which signing Samsung offers for installing on any customer's signage
display is a question for Samsung's SSSP partner programme, and until it is
answered the module installs on displays Apteo has listed. That is recorded as
an open dependency rather than decided here.

### The players' shared rules

The web shell and the Tizen shell load the same player and behave the same way:

- Screen content and pictures are cached per instance and screen, the data in
  `localStorage` and the pictures in IndexedDB, both private to the app, and
  shown when the instance cannot be reached - for at most 24 hours since the last
  successful fetch, after which the screen shows that it is not connected and
  nothing else.
- Each fetch replaces the screen content whole, so a slide that has left it,
  such as an addon switched off for the screen or a resident who objected, is
  gone from the cache at the same moment it is gone from the screen. A paused
  screen holds no content and no picture, only what it needs to resume: its
  token, its key and its `screenSecret`.
- Each answer is handled as the table under "Pairing" says, and nothing but a
  401 from the instance's device route or `released` from the pairing service
  makes a screen forget its pairing.
- Every request to the instance carries the device token in the `Authorization`
  header and nothing in the URL.
- Every text on the screen goes through the player's own translations, in the
  screen's locale. A first-load failure says which instance it tried, the HTTP
  status and the screen's id, in letters large enough to read on the wall.

## Consequences

- A screen is paired in the time it takes to type ten characters, and is unpaired
  from the instance without anybody going to it.
- The association's screen configuration stays on its own instance, and the
  pairing service holds nothing about what a screen shows or about anybody living
  in the house. What the instance sends Apteo is the pairing code, the sealed
  handover and the screen's release channel. The module's data protection review
  classifies Apteo AB as a processor for the screens' and the instance's
  connection data, under a processor agreement that comes with the module's
  terms, and as an independent controller only for the customer account and its
  billing.
- Names on a wall rest on a judgement the association makes as controller. The
  module supplies a surname-per-door default on legitimate interest, with the
  residents told beforehand and an objection that takes a name off before it is
  shown, and a consent-for-every-name mode for an association that prefers it.
  Which is the default is the board's decision.
- A compromise of the pairing service can stop pairings, release screens and
  withhold releases. It cannot read a screen's content, cannot hand the instance
  a key of its own for a screen, and cannot put unsigned code on a TV. It can
  seal a handover of its own to a screen being paired, because anyone with the
  screen's public key can, and point that screen at content that is not the
  instance's: the board sees it on the screen it is pairing, and the plugin's
  admin screen shows a paired screen whose token has never been used.
- Pausing the module is switching the plugin off: every screen blanks at its
  next fetch, within a minute, and comes back within a minute of the plugin
  being switched on again, with no pairing.
- Signing keys are a custody question for the module's infrastructure: where the
  offline keys are kept, who can sign, and how a key is retired.
- The current app's backend scraped the door-entry system for residents and
  fetched a poster from a URL. Neither is carried over: residents come from the
  register through the residents addon, and a picture is one the board stored on
  the instance. A server-side fetch of an address the board typed would be a way
  for the instance to be made to fetch anything.
- The current app has no licence, so its code is not copied. The behaviour is
  rewritten against the plugin API; the headless signing scripts are the part
  worth keeping closest, if their authors license them.

## Rejected alternatives

- **The instance pushing to screens.** It would need a way into the building's
  network, through NAT, for every screen.
- **The device token passing through the pairing service in the clear.** Apteo
  would then hold a credential that reads every paired screen's content.
- **A random pairing code issued by the pairing service.** The instance could
  not tell whether the key it was given belonged to the screen the board was
  looking at.
- **The whole player inside the TV package.** Every change to the player would
  need a new signed package and the display's own update, and one package could
  not serve every association.
- **Licence checks in the plugin.**
- **Native apps for other TV platforms.** Deferred, not rejected: Android TV and
  LG webOS can take the web shell's approach later.

## Revisit triggers

- **Samsung answers the signing question**: the installation path for displays
  outside Apteo's list.
- **A screen needs interaction**, such as a booking made at the laundry room
  door: that needs a device that writes, which ADR 0031 does not allow.
- **An association wants signage without Apteo's pairing service**: what a
  self-hosted pairing service would have to offer, and what the entitlement
  would mean then.

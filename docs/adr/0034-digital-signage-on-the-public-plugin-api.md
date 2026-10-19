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
    "personalData": [],
    "view": { "module": "./View", "titleKey": "view.title" },
    "deviceRoutes": [{ "id": "screen", "path": "screen" }],
    "extensionPoints": [
      { "id": "source", "version": 1, "personalData": ["name", "apartment"] },
    ],
  },
}
```

The plugin reads nothing from the register (it may not, holding a device route)
and handles no personal data of its own. What an addon hands it at `source` is
the one way a name reaches a screen, and the board consents to that twice: once
to `signage` accepting names and apartments at `source`, and once to the addon
handing them over.

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
  for screens, and none is picked by default. A news item can name a resident in
  its body as easily as a comment can, and everybody passing the screen reads it,
  so the choice is made item by item, where the picker says so. The choice is the
  plugin's rather than a field on the news item: the core cannot know which of a
  plugin's purposes an item is fit for, and the plugin can (ADR 0032).
- **The label is where the screen hangs**, such as "Entrance 3B", and the field
  says not to use a resident's name.

**What it serves to a screen**, on the device route at
`/api/plugin/signage/screen/`:

- `GET content` returns the screen content document, version 1: the screen's
  label, layout, rotation and schedule, how often to ask again
  (`refreshSeconds`, 60 by default, 30 at least), and the slides in order, each
  with its source, how long it stays and what it shows. It carries an `ETag`,
  and a screen asking with `If-None-Match` gets a 304.
- `GET pictures/<mediaFileId>` returns a picture, and only one the current
  document refers to.

The base module's sources carry no personal data from the register: the news
items and events the board picked, occurrences with no sign-up names, meeting
notices with no attendance, busy intervals with no booker, and pictures declared
to show no identifiable person (0032). The test for that is an acceptance
criterion of the module: the screen content of a screen with no addon switched on
holds no field taken from the register, no booking history, and no news item or
event the board did not pick for screens.

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
  | opens it, then fetches screen content from the instance ------>|
```

1. **The screen registers.** The shell makes an ECDH P-256 key pair with WebCrypto
   (the private key is non-extractable and stays in the shell's storage) and
   calls `POST /v1/screens` with the public key and what it is: the shell's kind
   and version, and for a Samsung display its model and Unique ID. It gets back
   a `screenId` and a `screenSecret`, which authenticates it to the pairing
   service from then on.
2. **The code comes from the key.** The pairing code is the first 50 bits of the
   public key's JWK thumbprint (RFC 7638), written as ten characters of
   Crockford base32 in two groups (`7KQ3M-X2HDA`). The shell shows it, and the
   pairing service accepts it for 15 minutes. The shell then registers again
   with a fresh key.
3. **The board types the code** into the plugin's admin screen. The plugin calls
   `POST /v1/pairings`, gets the screen's id and public key, and computes the
   code from the key itself. A key that does not give the code the board typed
   is refused. This is what stops the pairing service, or anyone who has taken
   it over, from putting a key of its own in place of the screen's: it would
   have to find a key whose thumbprint starts with the same 50 bits within the
   15 minutes the code is valid.
4. **The instance issues the token and seals it.** The plugin issues a device
   token for the `screen` route with the screen's id as its subject (0031),
   encrypts `{ v: 1, contentUrl, token, screenId, instance: { origin, name } }`
   to the screen's public key as a JWE (RFC 7516, `ECDH-ES` with `A256GCM`), and
   hands the JWE to the pairing service.
5. **The screen collects it**, opens it, confirms, and the pairing service
   deletes it. A handover not collected within 15 minutes is deleted unopened.

The pairing service therefore never holds a device token it can read, and the
protocol never tells it the instance's address.

**Unpairing.** The board unpairs a screen in the admin screen: the plugin revokes
its device token and calls `DELETE /v1/screens/{id}`. The board can also revoke
the token from the core's own screen (0031), which is enough on its own: the
next call from the screen is refused.

**What a screen does when it is refused.** A 401, 403 or 404 from the instance
means the screen is no longer this instance's. The shell wipes everything it
holds - screen content, pictures, the token, its key - and registers again, so
it shows a new pairing code and nothing else. A network failure or a 5xx keeps
the last good content on the screen with a small note saying when it was
fetched. An unpaired screen shows its pairing code and its own details and
nothing from any instance.

### The pairing service API, version 1

All bodies are JSON and every refusal is `{ "reason": "<code>" }`. The address
of the service is the module's to choose.

What a screen tells the pairing service is limited to what the table below names:
the shell's and the player's versions, the display's model and Unique ID, the
outcome of a release, and its address as the network shows it. No screenshot,
no rendered content and no screen content ever passes through it, and no
endpoint accepts a field it does not name. The service keeps its request logs
for at most 30 days and runs in the EU/EEA.

**For a screen**, authenticated with `Authorization: Bearer <screenSecret>`
except for registering:

| Request                             | Answer                                                                                                                         |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `POST /v1/screens`                  | 201 `{ screenId, screenSecret, pairingCode, pairingExpiresAt, pollSeconds }`. Rate limited per client address.                 |
| `GET /v1/screen`                    | `{ state, pairingCode?, pairingExpiresAt?, handover?, release?, pollSeconds }`. `state` is `unpaired`, `paired` or `released`. |
| `POST /v1/screen/handover-received` | 204. The handover is deleted.                                                                                                  |
| `POST /v1/screen/report`            | 204. `{ sequence, outcome }` after a release started (`started`) or was reverted (`reverted`), for the staged rollout to read. |

`released` means the instance unpaired the screen: the shell wipes and
registers again. A screen polls every 5 seconds while unpaired and about once an
hour when paired, as `pollSeconds` says; it asks the instance for content on its
own clock.

**For an instance**, authenticated with `Authorization: Bearer <instance key>`:

| Request                               | Answer                                                                                                                                   |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /v1/entitlement`                 | `{ status, screensIncluded }`, `status` being `active`, `lapsed` or `none`.                                                              |
| `POST /v1/pairings` `{ pairingCode }` | `{ screenId, publicKey, shell, display }`, or `pairing-code-unknown` (404), `entitlement-required` (402), `screen-already-paired` (409). |
| `PUT /v1/screens/{id}/handover`       | 204, or `handover-already-collected` (409).                                                                                              |
| `PUT /v1/screens/{id}/channel`        | 204. `{ channel }`, `stable` or `beta`.                                                                                                  |
| `GET /v1/screens`                     | The instance's screens as the pairing service sees them: state, shell and player versions, last seen.                                    |
| `DELETE /v1/screens/{id}`             | 204. The screen is `released`.                                                                                                           |

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
  "files": [{ "path": "player.js", "sha256": "<base64url>", "bytes": 48213 }],
}
```

- **The manifest is signed** with ECDSA P-256 and SHA-256 (`ES256`), in a
  detached `manifest.sig` holding `{ keyId, sig }`, the signature over the
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
  origin, which has not been observed on hardware, does not need to be known.
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
  the versions, the viewports, the scale and the instance's host, never a token
  and never content, and nothing in it is sent anywhere.

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
  gone from the cache at the same moment it is gone from the screen.
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
- A compromise of the pairing service can stop pairings and withhold releases.
  It cannot read a screen's content, cannot hand a screen a key of its own, and
  cannot put unsigned code on a TV.
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

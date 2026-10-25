# Digital signage

Digital signage puts a screen in the entrance, the stairwell or the laundry room
that rotates the association's news, its events, the notice of the next general
meeting, free and busy times for bookable resources and pictures the board
chooses. This page is for two readers: the self-hoster who runs an instance and
wants screens on its walls, and the author of an addon that adds slides to
those screens.

**Digital signage is a paid module and needs an Apteo entitlement.** Without
one the module pairs no screen. The decision, and why the open code checks no
licence, is
[ADR 0034](adr/0034-digital-signage-on-the-public-plugin-api.md), "Entitlement".

What the core offers without the module is free and unchanged: the display
mode, a read-only view of the same content that a self-hoster opens in a kiosk
browser from a display link ([ADR 0050](adr/0050-the-display-mode-and-one-renderer-for-every-screen.md)).
Nothing in the module is the only way to show an instance's content on a
screen.

## What the module is

Digital signage is a plugin, `signage`, built on the public
[plugin contract](plugin-contract.md) and nothing else in the core, with parts
Apteo runs around it:

<!-- prettier-ignore -->
| Part | What it does | Where it runs |
| --- | --- | --- |
| The `signage` plugin | Keeps the screens, serves each its screen content on a device route, offers the `source` extension point, and talks to the pairing service | On your instance |
| The pairing service | Pairs a screen to an instance, holds the instance's entitlement and serves signed player releases. It holds no screen content, no configuration of what a screen shows and nothing about the association's people | Apteo's, at `https://signage.openbrf.se` |
| A shell | The part installed on the screen: pairing, identity, diagnostics and loading the player. A hosted page for a kiosk browser, an image for a Raspberry Pi, or an app for a Samsung Tizen signage display | The screen |
| The player | The signed code the shell loads, which renders the screen content with the core's own renderer, `@openbrf/display` | The screen |
| Addons | Plugins that add slides at the `source` extension point, such as `signage-residents` | On your instance |

The instance never connects to a screen. A screen fetches from the instance and
from the pairing service, so nothing needs a port opened towards the
building's network.

The module's source is private, and so is the source of the residents addon.
Each is released as a built package from a public release-only repository, as
[ADR 0044](adr/0044-a-listing-released-from-a-repository-without-its-source.md)
describes, and a person reads the plugin's server bundle before it is listed.
Like every plugin, each runs in your instance's process with the instance's
privileges ([ADR 0003](adr/0003-plugin-loading-and-module-resolution.md)).

## For self-hosters

### What you need

- **An Apteo account.** Apteo issues the instance an **account key** in its
  customer panel, which begins `obrf_ak_`, and sets the entitlement of its instance: `active`,
  `lapsed` or `none`, and how many screens it includes. The pairing service
  holds both. Nobody can run the module's hosted parts, pairing and player
  releases, without them.
- **An instance that has what the module reads.** It reads news items, events,
  bookable resources' free and busy times, pictures and addresses through the
  plugin API. The module's own screen says whether the instance has what it
  needs.
- **Screens.** A kiosk browser, a Raspberry Pi 4 or 5, or a Samsung signage
  display (SSSP, such as the QM43C). A screen needs a network connection that
  can reach your instance and `signage.openbrf.se` over HTTPS, and nothing
  towards it.

### Where it stands

Read this before you plan an installation. It is as of this writing, and
changes as the module is released:

- The plugin and the residents addon are built and tested, but neither has a
  release in the [catalog](https://github.com/openbrf/catalog) yet, so a
  board cannot install them from the plugins screen. The listing's description
  says that the module needs an Apteo account.
- No production player release is signed yet. Apteo defers signing until its
  1.0 release, and until then the pairing service ships with an empty list of
  release keys. A shell pins that list, so a shell for production cannot be
  built, and no screen can be paired.
- Samsung's rules for installing an app on a display outside Apteo's own list
  are not settled
  ([ADR 0034](adr/0034-digital-signage-on-the-public-plugin-api.md),
  "Revisit triggers").

### Installing the module

1. Install `signage` from the catalog on the board's plugins screen. The
   consent screen lists what it asks for before anything is downloaded:
   permissions to read news, events, bookable resources' free and busy times,
   pictures and addresses; the personal data categories it handles; its
   declared processing; and its one recipient, the pairing service.
2. Open its settings on the plugins screen. Enter the **account key** and the
   **association's name for screens**. The key is a secret setting: it is kept
   encrypted, never returned by a route, and sent only to the pairing service
   ([ADR 0037](adr/0037-declared-outbound-hosts-and-secret-settings.md)).
   Installing the module makes no call to Apteo, and neither does its screen
   until a key is entered.
3. Open the module's screen, "Digital signage", in the board's section.

### Pairing a screen

1. Start the screen. A kiosk browser opens `https://screen.openbrf.se`; the
   Raspberry Pi image and the Samsung app start straight into the shell. The
   screen shows sixteen characters.
2. On the module's screen, type them and say where the screen hangs: which
   address, and whether it is visible from outside the building.
3. The module and the screen do the rest. The module sends the pairing service
   the first ten characters, the pairing code, and keeps the last six for that
   one request, so the service cannot pair a screen to an instance the board
   did not type the characters into. The instance then issues the screen a
   device token for its `screen` route and hands it over sealed to the
   screen's own key
   ([ADR 0031](adr/0031-a-device-token-for-a-plugin-s-own-routes.md)).

A step that fails after the token is issued gives the screen back and leaves
nothing behind: the token is revoked and the record deleted.

### Configuring a screen

Everything a screen shows is configured on your instance, never at the screen.
For each screen the board sets its label and where it hangs, its language, its
layout, how often it fetches, its sources, its bookable resources, its
pictures, when it is on, its release channel and the addons switched on for it.
A screen picks a change up at its next fetch, and a screen fetches at least
once a minute.

News items and events appear only when the board marked them **Show on
screens** in the core's news and event editors. A screen visible from outside
the building shows only what is for anyone: no member's news item, event or
picture, and no notice of the general meeting.

### What screens show, and what they never show

The built-in sources are the marked news items, the marked events starting
within 31 days, the notice of the next general meeting called, free and busy
times for the resources the board chose, and the pictures the board chose.

**The base module shows no personal data.** The module serves screens through a
device route, so the host hands it less than it hands a signed-in person
([ADR 0032](adr/0032-read-only-content-for-plugins.md)): no item whose text
names somebody the register holds, no apartment number, no booker, no
booking that has already ended, and only pictures uploaded as showing nobody
recognisable. A picture has no caption, so no text the board typed reaches a
wall without the host's check. An addon may show names: see
[Addons on your screens](#addons-on-your-screens).

The screen content's shape is [the screen content
contract](screen-content-contract.md).

### What is sent to Apteo

The consent screen names one recipient, the pairing service. It receives:

- the account key;
- the pairing code, the first ten characters a screen shows, and never the last
  six;
- the sealed handover to the screen, which the service cannot read;
- the screen's release channel.

It receives no screen content and nothing about the association's residents.
Apteo AB is a processor for the screens' and the instance's connection data
under a processor agreement that comes with the module's terms, and an
independent controller only for the customer account and its billing
([ADR 0034](adr/0034-digital-signage-on-the-public-plugin-api.md),
"Consequences"). A screen also asks the pairing service for player releases,
`screen.openbrf.se` serves the kiosk shell, and a Raspberry Pi takes its
updates from Apteo's package archive.

### Updates

The player updates itself from signed releases that the shell verifies against
the keys it pins. It never runs an unsigned player and never goes back to an
older one, and a release that fails to start is dropped for the previous
player. A Raspberry Pi takes the system's security updates daily and the
shell's updates from Apteo's package archive. A Samsung display
takes a new version of the app only as a new package installed on it, and
only a higher version than the one it has; the player in it still updates by
signed release.

### When something stops

- **The entitlement lapses.** The pairing service stops pairing new screens
  (`entitlement-required`) and serving new player releases. Screens already
  paired keep running the player they have and keep showing what your instance
  serves them: the content route is the association's own and carries no check.
- **The pairing service cannot be reached.** Screens keep showing your
  instance's content. The module tells the service about unpairing and release
  channel changes the next time it can.
- **You switch the plugin off.** Every screen blanks at its next fetch, within
  a minute, and comes back within a minute of the plugin being switched on
  again, still paired.
- **You unpair a screen.** On the module's screen, which revokes its token and
  deletes its record. Revoking the token on the core's devices screen is enough
  on its own, and the screen then wipes its pairing and shows a new code.
- **You remove the plugin.** Its device tokens and records go with it.

### Addons on your screens

An addon is a plugin of its own that adds slides to a screen's rotation. It is
installed, consented to, switched on and removed by itself, and it never
receives the module's permissions, nor the module its own. The module serves it
only while both are installed and switched on.

An addon is **off on every screen until the board switches it on for that
screen**, including screens paired later. Switching it on asks first: it names
the screen and its address, says that what the addon shows is visible to
everyone who passes the screen, and shows the addon's own description of what
it shows. Each switch is an audit entry, `screen.addon-on` or
`screen.addon-off`, with the board member as the actor. An instance without an
audit log refuses to switch an addon on.

An addon that is not serving, fails, takes more than five seconds or answers
outside the point's shape gives no slides, and the rest of the rotation is
served without it. Nothing that shows names reaches a screen placed outside the
building: the module refuses to switch an addon on for one, and leaves out
every `doors` slide from one.

Apteo's first addon, `signage-residents`, shows the surnames on each door of
the entrance a screen inside the building hangs in, as a name board does.
Names on a wall rest on a judgement the association makes as controller:
read the addon's own screen, "Residents on screens", before the first name is
shown. It gives the text for the privacy notice and tells the board to inform
the residents first.

## For addon authors

An addon is any plugin that extends a host plugin's extension point
([ADR 0030](adr/0030-plugins-that-extend-plugins.md)); how the loader, the
manifest and `host.extensions` work is in the plugin contract's
[Extension points](plugin-contract.md#extension-points). This section is what is
particular to digital signage's point, `source`, version 1
([ADR 0034](adr/0034-digital-signage-on-the-public-plugin-api.md), "The `source`
extension point, version 1"). You write against the public plugin API only, as
Apteo's own addon does. You cannot run the paid host plugin without an
entitlement, so test your handler against the shapes below.

[`docs/examples/signage-addon`](examples/signage-addon/README.md) is a complete
addon to start from: a package that shows the laundry room's rules, built and
tested on its own against the published `@openbrf/plugin-sdk`, with a script
that writes a catalog index an instance can install it from.

### Declaring the addon

```jsonc
{
  "name": "@example/openbrf-signage-rules",
  "version": "1.0.0",
  "files": ["dist", "locales"],
  "openbrf": {
    "apiVersion": 1,
    "id": "signage-rules",
    "entry": { "server": "./dist/server.cjs" },
    "extends": [{ "plugin": "signage", "point": "source", "version": 1 }],
  },
}
```

- `extends` names `signage`, the point `source` and version `1`. An addon
  written for another version is refused with `extension-version-unsupported`.
- If your slides carry names or apartments, declare them in `extends[].personalData`
  and in the addon's own `personalData`, with a `processing` declaration
  ([The processing declaration](plugin-contract.md#the-processing-declaration)).
  `source` accepts `name` and `apartment` and no other category. A category the
  point does not accept is refused when the addon loads.
- Declare the permissions your handler needs and no others. `signage` never
  grants you its own.
- A plugin that extends another declares no `extensionPoints` of its own. The
  plugin contract's [Extension points](plugin-contract.md#declaring-a-point)
  lists which permissions an addon cannot combine with the plugins it is joined
  to.

### The input

The host validates the input before each call. The screen's own `id` is
opaque: treat it as a key and nothing else.

```ts
{
  screen: {
    id: string; // 1 to 64 characters
    addressId: string | null; // the address the board says the screen hangs at
    placement: "inside" | "outside"; // visible from outside the building or not
    locale: "sv" | "en";
  }
}
```

Accept fields you do not know: the module may add an optional field without
raising the point's version.

### The output

`{ slides }`, at most eight, each one of:

```ts
| { kind: "text"; heading: string; body: string[] }
| { kind: "table"; heading: string; columns: string[]; rows: string[][] }
| { kind: "doors"; heading: string; doors: { floor: number | null; apartment: string; names: string[] }[] }
```

<!-- prettier-ignore -->
| Limit | Value |
| --- | --- |
| Slides | 8 |
| Heading | 200 characters |
| `text` body | 40 paragraphs, 2 000 characters together |
| `table` | 1 to 4 columns, 60 rows, a column title of 80 characters and a cell of 200 |
| `doors` | 120 doors, an apartment of 20 characters, 12 names to a door, a name of 80 characters, a `floor` from -20 to 200 or `null` |
| Time to answer | 5 seconds |

Every object is strict and every string is plain text. The host checks the
answer against the limits above before the module reads it. It refuses an
answer with a key the point does not name, at any depth, and also one with a
single string over its limit: a heading of 201 characters, a paragraph of
2 001, a table row of more than four cells, an empty `apartment` or an empty
name. The call then fails with `output-invalid` and the addon gives no slides
at all for that fetch, the slides within the limits included.

What the module changes in an answer the host accepted is only this: it
shortens the paragraphs of a `text` slide with "…" where together they pass
2 000 characters, leaves out a paragraph that is empty, and fills a table row
with empty cells, or cuts it, to the slide's columns. Each slide stays on the
screen for 20 seconds.

A `doors` slide names people, so an addon that sends one declares `name` and
`apartment`. The module leaves every `doors` slide out for a screen placed
`outside`, whatever an addon answers.

### A handler

The handler's input is not inferred from the target, so give `contribute` the
input and output types. The sample copy is in the addon's own locale files,
with the same keys in both. `locales/en.json`:

```json
{
  "source.title": "Laundry room rules",
  "source.description": "Shows the rules of the laundry room to everyone who passes the screen.",
  "laundry.heading": "Laundry room",
  "laundry.body": "Switch the machines off after use."
}
```

`locales/sv.json`:

```json
{
  "source.title": "Regler för tvättstugan",
  "source.description": "Visar tvättstugans regler för alla som passerar skärmen.",
  "laundry.heading": "Tvättstugan",
  "laundry.body": "Stäng av maskinerna efter användning."
}
```

The handler's `t` comes from an i18next instance of the addon's own, which
reads those files and answers in `input.screen.locale`:

```ts
import { createInstance } from "i18next";
import type {
  ExtensionContext,
  PluginHost,
  PluginModuleFactory,
} from "@openbrf/plugin-sdk";
import en from "../locales/en.json";
import sv from "../locales/sv.json";

interface SourceInput {
  screen: {
    id: string;
    addressId: string | null;
    placement: "inside" | "outside";
    locale: "sv" | "en";
  };
}

interface SourceOutput {
  slides: { kind: "text"; heading: string; body: string[] }[];
}

class SignageRulesModule {}

const i18n = createInstance();
const ready = i18n.init({
  resources: { sv: { translation: sv }, en: { translation: en } },
  fallbackLng: "sv",
  interpolation: { escapeValue: false },
});

export const createPlugin: PluginModuleFactory = (host: PluginHost) => {
  // An instance without extension points never offers an addon, so this
  // contributes nothing there.
  host.extensions?.contribute<SourceInput, SourceOutput>(
    { plugin: "signage", point: "source" },
    {
      titleKey: "source.title",
      descriptionKey: "source.description",
      handler: async (input: SourceInput, _context: ExtensionContext) => {
        await ready;
        const t = i18n.getFixedT(input.screen.locale);
        return {
          slides: [
            {
              kind: "text",
              heading: t("laundry.heading"),
              body: [t("laundry.body")],
            },
          ],
        };
      },
    },
  );
  return { module: SignageRulesModule };
};
```

The host gives a handler no translator, so the addon reads its own files. The
host merges the same files into the addon's namespace for the board's screens,
which is where `titleKey` and `descriptionKey` are read.

- `titleKey` and `descriptionKey` are bare keys in the addon's own locale
  files. The board sees the description when it switches the addon on for a
  screen, so say there what the addon shows and to whom: everyone who passes
  the screen.
- Read data inside the handler and not before, so an objection the board
  granted, a restriction or a move-out takes effect at the screen's next
  fetch. The host leaves out of a read made while the handler answers every
  person whose objection to the host plugin's processing the board granted
  ([ADR 0035](adr/0035-a-plugin-s-processing-and-objecting-to-it.md)).
- Honour `context.signal`: it is aborted when the five seconds are over, and a
  late answer is dropped. A handler that loops synchronously stalls the whole
  instance, which the time limit cannot stop.
- Return no slides, rather than a slide with a message, when the addon has
  nothing to show or must not show it, for example where `placement` is
  `outside`.
- Keep nothing the handler read. The addon's `processing` retention is "not
  stored" only if it is true.

### Testing it

Test the handler on its own with the input above, and check its output against
the table with a strict schema of your own that mirrors the shapes and limits.
Check each string against its own limit and not only the total: the host
refuses a single string over its limit, or a stray key, with `output-invalid`
and the addon gives no slides, whereas the module shortens only the combined
paragraphs of a `text` slide. The plugin contract's
[Extension points](plugin-contract.md#defining-and-contributing) shows how the
host calls a contribution and what it answers when the call fails. The sample
addon's `test/` does both: it calls the built bundle's handler with a fake host
and holds each answer to such a schema.

### Getting listed

An addon is listed in the [catalog](https://github.com/openbrf/catalog) like any
plugin, by a pull request that adds its entry. The entry's `extends` must match
the package's, and the index refuses an addon entry whose host entry declares
no such point, declares it at another version or does not accept the personal
data the addon hands over. A maintainer reads the addon's server bundle and
the declaration the board will be asked to consent to before approving the
pull request. What a listing must meet is
in [the plugin contract](plugin-contract.md#what-a-listing-must-meet) and the
catalog's README.

### What an addon must not assume

- That the host plugin is installed. An addon waits with `extension-host-missing`
  until it is, and stops when the host plugin is switched off or removed.
- That a screen is private. What an addon shows is visible to everyone who
  passes it: guests, couriers and neighbours from other entrances.
- That the host plugin protects the addon from itself. There is no sandbox, and
  catalog curation is what keeps hostile code out of an instance.

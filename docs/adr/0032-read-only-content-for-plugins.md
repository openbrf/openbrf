# ADR 0032: Read-only content for plugins

Date: 2026-10-19

## Status

Accepted. Adds permissions to the plugin contract; the three rules that hold on
every register read stand unchanged.

## Context

The host object a plugin receives offers settings, mail, text messages, jobs,
actions and the address book. Nothing the association **publishes** is on it:
not its news, not its event calendar, not the general meeting it has called, not
whether the laundry room is free. A plugin that wants to show any of it - on a
screen in the entrance, in a weekly digest, in a calendar feed - has no way to
read it.

Each of these is already published by the core, to the members or to anyone,
and the website reads them without a person for a visitor. What is missing is a
narrow, read-only way for a plugin to read the same thing, under a permission the
board sees on the consent screen.

## Decision

### Five permissions

| Permission                  | Grants                                                                                                                               |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `news:read`                 | Published news items: the title, the body, its pictures, when it was published and whether it is for the members or for anyone.      |
| `calendar:read`             | Published events and their occurrences, and the notice of every general meeting that has been called and not yet held.               |
| `bookings:readAvailability` | The bookable resources that are open for booking, and when each is taken. Never by whom.                                             |
| `media:read`                | A stored picture, by its id, where it is for the members or for anyone and its upload declared that it shows no identifiable person. |
| `addresses:read`            | The association's addresses - the street and number of each entrance - and nothing about who lives at them.                          |

None of them names a person, and none of them is a permission on the register:
each reads what the association has already published, or a fact about the
building. They are therefore not register permissions in the sense of ADR 0031,
and a plugin with a device route may hold them.

**The audience travels with the item.** A news item and an event are each for
the members or for anyone, and the plugin is told which (`members` or `anyone`)
on every item. What the plugin does with a members' item is its own declared
purpose: a screen inside the building may show it, a public calendar feed should
not. The host does not decide that for the plugin, because the right answer
depends on where the plugin puts it, and the plugin's consent screen is where the
board reads that. A plugin that puts items where anybody passing can read them
should let the board pick the items, as the signage module does (ADR 0034):
published text can name a resident as easily as a comment can.

**Never anything written about a person.** No author of a news item or an event,
no comment, no like, no read count, no sign-up and no roll-call, no booker and no
apartment on a booking, no motion's mover. A meeting notice carries its time, its
place, the instruction for taking part digitally and the agenda's titles; never
the attendance, the voting register or a proxy. Text the board wrote is returned
as written, and may of course name somebody: that is the board's publication, as
it is on the website, and the plugin's consent screen says that it shows
published text.

### The host object

```ts
export interface PluginNews {
  /** Published items, newest first. At most 50 per call. */
  published(options?: {
    audience?: "anyone" | "members";
    limit?: number;
    since?: string;
  }): Promise<readonly PluginNewsItem[]>;
}

export interface PluginNewsItem {
  readonly id: string;
  readonly title: string;
  /** The body's text, one string per paragraph or heading, in order. */
  readonly paragraphs: readonly string[];
  readonly pictures: readonly { mediaFileId: string; alt: string }[];
  readonly audience: "anyone" | "members";
  readonly publishedAt: string;
}

export interface PluginCalendar {
  /** Occurrences of published events starting in [from, to), at most 92 days. */
  occurrences(range: {
    from: string;
    to: string;
    audience?: "anyone" | "members";
  }): Promise<readonly PluginOccurrence[]>;
  /** Notices of general meetings called and not yet held, soonest first. */
  meetingNotices(): Promise<readonly PluginMeetingNotice[]>;
}

export interface PluginOccurrence {
  readonly eventId: string;
  readonly occurrenceId: string;
  readonly title: string;
  readonly description: string | null;
  readonly category: string | null;
  readonly location: string | null;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly calledOff: boolean;
  /** Places left when the event takes sign-ups; never who took them. */
  readonly placesLeft: number | null;
  readonly audience: "anyone" | "members";
}

export interface PluginMeetingNotice {
  readonly meetingId: string;
  readonly kind: "ordinary" | "extraordinary";
  readonly startsAt: string;
  readonly place: string;
  readonly digitalParticipation: string | null;
  readonly agenda: readonly { position: number; title: string }[];
}

export interface PluginBookings {
  resources(): Promise<readonly PluginBookableResource[]>;
  /** When each resource is taken in [from, to), at most 31 days. */
  busy(range: {
    from: string;
    to: string;
    resourceIds?: readonly string[];
  }): Promise<readonly { resourceId: string; start: string; end: string }[]>;
}

export interface PluginBookableResource {
  readonly id: string;
  readonly name: string;
  readonly mode: "timeSlots" | "wholeDay" | "dateRange";
  readonly slotMinutes: number | null;
  readonly opensAtMinute: number | null;
  readonly closesAtMinute: number | null;
}

export interface PluginMedia {
  /** Null when the file does not exist or is not one a plugin may read. */
  open(mediaFileId: string): Promise<{
    contentType: string;
    byteSize: number;
    checksum: string;
    stream: ReadableStream<Uint8Array>;
  } | null>;
}

export interface PluginAddresses {
  list(): Promise<readonly { id: string; street: string; number: string }[]>;
}
```

They are `host.news`, `host.calendar`, `host.bookings`, `host.media` and
`host.addresses`, present on every host object and refusing with
`PluginPermissionError` without their permission, as the existing services do.
Times are instants in ISO 8601; the association's calendar day is the core's
(ADR 0013). Each service reads through the same service method the website or
the resident's own screen reads through, so a plugin is never shown an item the
core would not publish: an unpublished, withdrawn or deleted item is absent, a
called-off occurrence is present and says so, and a deactivated resource is
absent.

`busy` returns intervals and nothing else, merged where two bookings touch, so
that a sequence of slots cannot be read as one apartment's habits. `media:read`
opens only a picture (an image content type) whose visibility is public or
members and whose upload answered "shows no identifiable person": a photograph of
people needs a publication consent, and the consent the core records is for the
website, not for wherever a plugin puts it. A file the plugin may not read and a
file that does not exist both answer `null`.

### The capability floor

A plugin's routes are raised to the floor its permissions imply (ADR 0003). None
of the five raises it above `self:manage`, the floor every plugin has: what they
read is what anybody signed in may read already. `bookings:readAvailability`
reads less than a resident's own booking screen shows, which is why it needs no
`bookings:book`.

### The catalog

The five values are new members of the permission list, which the version 1
index reads as a closed set, so a plugin entry that asks for one is version 2 of
the index (ADR 0030).

## Consequences

- A plugin can show the association's published life without reading the
  register, and the consent screen can say so in words a board recognises: it
  reads the news and the calendar.
- A members' item can now leave the members' screens through a plugin. The
  audience is on every item so that the plugin cannot plead ignorance, and the
  plugin's own declaration is what the board consents to.
- Five more services the module seal has to keep wrapped: each reaches a core
  service a plugin may not inject, and the host hands it over narrowed. The
  classification check over the global modules (ADR 0008) catches one that is
  exported and not classified.
- The services are added after this contract version shipped and are
  feature-detected; a permission an older instance does not know fails its
  manifest schema, so such a plugin is refused rather than loaded without it.

## Rejected alternatives

- **One `content:read` permission.** A board deciding about a weekly digest
  should not have to consent to free/busy times as well, and each of the five
  reads a different kind of thing.
- **Letting a plugin call the core's own HTTP routes.** Those answer to a
  person, and a plugin serving a device has none.
- **Filtering by audience in the host.** The host cannot know whether the plugin
  puts an item inside the building or on the street; the plugin can, and says so
  on its consent screen.

## Revisit triggers

- **A plugin needs a published page or a document** from the archive: the same
  shape, with the archive's own rule about which shelf a reader may see.
- **A plugin needs to know who has signed up** to an occurrence: that is personal
  data, and it is a register-style permission with the rules that come with one.

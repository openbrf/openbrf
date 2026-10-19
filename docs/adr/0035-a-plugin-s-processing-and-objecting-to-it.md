# ADR 0035: A plugin's processing, and objecting to it

Date: 2026-10-19

## Status

Accepted. Narrows what a plugin reads from the register; the three rules that
hold on every register read stand unchanged.

## Context

Installing a plugin writes it into the record of processing activities with the
categories its manifest declared. Everything else in that row is a placeholder:
the purpose is the plugin's name, the legal basis is legitimate interest with no
interest named, the retention is empty, and the people concerned are members and
residents whatever the plugin does. A board publishing its privacy notice from
that row would be publishing guesses, and a plugin that handles no personal data
at all gets a row claiming that it does.

A processing that rests on legitimate interest can be objected to (GDPR art.
21(1)), and the association then has to stop unless it has compelling grounds.
The objection the core records today is for communications and nothing else - the
news mailings and event invitations - and a plugin reading the register still
receives a person who has objected. A plugin that shows the residents of an
entrance on a screen in the stairwell rests on legitimate interest, so an
objection to it has to take the person off the screen, and today nothing could.

The data protection review of the digital signage module (ADR 0034) found both,
and three smaller things a plugin needs to read only what it uses and to account
for what it does: the register read is the whole association with every name in
full, there is no consent scope for a name on a screen inside the building, and a
plugin cannot write to the audit log.

## Decision

### The manifest declares the processing

```jsonc
{
  "openbrf": {
    "personalData": ["name", "apartment"],
    "processing": {
      "purpose": {
        "sv": "Visa vilket hushåll som bor bakom vilken dörr på skärmarna i husets entréer.",
        "en": "Show which household lives behind which door on the screens in the house's entrances.",
      },
      "legalBasis": "legitimateInterest",
      "legitimateInterest": { "sv": "...", "en": "..." },
      "retention": { "sv": "...", "en": "..." },
      "dataSubjects": ["members", "residents"],
    },
  },
}
```

| Field                | Required                  | Meaning                                                                                                                                  |
| -------------------- | ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `purpose`            | yes                       | What the processing is for, in Swedish and English, at most 500 characters each.                                                         |
| `legalBasis`         | yes                       | `consent`, `contract`, `legalObligation` or `legitimateInterest`. The two art. 6(1) bases a plugin has no business with are not offered. |
| `legitimateInterest` | with `legitimateInterest` | The interest relied on, which art. 13(1)(d) requires on the privacy notice.                                                              |
| `retention`          | yes                       | How long the data is kept and when it goes.                                                                                              |
| `dataSubjects`       | yes                       | `members`, `residents` or both.                                                                                                          |

A plugin that declares personal data declares `processing`, and one that
declares none declares no `processing` and gets no row in the record of
processing activities. The consent screen shows the declaration and the install
seeds the row from it, in the association's language. The board's own edits on
the data protection screen keep winning, as they do today, and a republished
version that changes the declaration does not overwrite them: it is shown on the
consent step as what the plugin now says. The field is in version 2 of the
catalog index (ADR 0030).

### An objection can name a plugin's processing

An objection the board records on the data protection screen can name one
processing activity instead of the communications: the row of a plugin in the
record of processing activities. Granting it writes a dated marker for that
person and that processing, and closing it writes the date it ended; neither is
deleted, for the reason a restriction is dated.

**The host enforces it.** A person with a standing objection to a plugin's
processing is absent from every read that plugin makes through
`host.addressBook` - absent, not flagged, as a person with protected personal
data is. The plugin is not told that anybody objected, so it cannot list who
did. Closing the objection brings the person back on the next read.

Because an addon reads the register through its own host object (ADR 0030),
an objection to the residents addon takes the person out of what it hands the
signage plugin, and so off every screen, on the next fetch of screen content.

The communications objection the core records today is unchanged and is a
separate thing: objecting to a name on a screen is not objecting to the news
mailing, and the board records which the person meant.

### The address book reads less

`host.addressBook` gains a filter and two fields:

```ts
residents(filter?: { addressId?: string }): Promise<PluginResident[]>;

export interface PluginResident {
  // ...the fields it has today...
  /** The family name alone, for a reader that shows no first names. */
  lastName: string;
  /** A standing publication consent to the name on screens in the building. */
  nameInBuilding: boolean;
}
```

- `addressId` returns only the residents of that entrance, so a plugin that
  shows one entrance never loads the others.
- `lastName` lets a plugin show a household as the name on the door shows it,
  without the first names that say who lives alone and name the children.
- `nameInBuilding` reads a new publication-consent scope, `NAME_IN_BUILDING`,
  recorded on the person's panel like the other scopes and dated the same way.
  It is a different scope from `NAME_ON_SITE`, because a name on a screen
  inside the building and a name on a website anyone can read are different
  things to agree to. A plugin that shows first names only with that consent,
  and the surname otherwise, needs nothing else from the core.

### A plugin can write to the audit log

The host object gains `host.audit`:

```ts
export interface PluginAudit {
  record(
    request: ActionRequest | null,
    entry: {
      event: string;
      targetKind?: string;
      targetId?: string;
      detail?: Record<string, string | number | boolean>;
    },
  ): Promise<void>;
}
```

The entry is written as `PLUGIN_RECORDED`, with the plugin's id and the event,
on the `PLUGIN` channel. With a request, the actor is the person the host marked
on it, as for `host.actions`; with `null`, the entry has no actor. `event` is
lowercase letters, digits, dots and hyphens, at most 64 characters, and the audit
log shows it through the plugin's own text key `audit.<event>`. `detail` holds at
most eight values of at most 200 characters, scanned for a personal identity
number as a page is. The entry is about what the plugin did - which screen the
residents were switched on for, and by whom - and never a copy of what it read:
a person is named as the actor, never in the detail.

`AuditLogService` stays out of a plugin's reach (ADR 0008). This is one action
value of the core's, written by the host, so the rule that every audit action is
a value of the core's own enum still holds.

## Consequences

- The record of processing activities states what a plugin is for, on what
  basis and for how long, from the day it is installed, and a plugin that handles
  no personal data is not in it.
- An objection to a plugin is something the board can grant on the same screen
  as every other request, and the platform carries it out, rather than a list the
  plugin keeps for itself that nothing ties to the request.
- A person who has objected disappears from the plugin's reads without the
  plugin learning who objected. A plugin that keeps its own copy of the register
  would defeat that, which is one more reason ADR 0033 forbids it.
- The data subject access report gains the per-processing objections and the
  new consent scope, and the change that adds them answers for them under ADR 0019.
- `host.audit` is added after this contract version shipped and is
  feature-detected; the two new address-book fields are additive.

## Rejected alternatives

- **An exclusion list kept by the plugin.** It splits the art. 21 decision from
  the record the board answers the request from.
- **Reading the communications objection as an objection to everything.** A
  person who wants no mailings has not asked to be taken off the door.
- **Publication consent for every name on a screen.** It is available, through
  `nameInBuilding`, to an association that prefers it. Whether a surname per door
  rests on legitimate interest by default is the association's judgement as
  controller, and the module supplies both.

## Revisit triggers

- **A core processing needs objections of its own**, beyond the communications:
  the per-processing marker is the shape, and it would no longer be only for
  plugins.
- **A plugin needs to name a person in an audit entry's detail.**

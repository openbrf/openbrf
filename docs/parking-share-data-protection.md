# Parking share: record of processing and consent copy

The paid parking-share module lets a resident offer a parking space they will
not use for a period and lets a neighbour claim it (see "Parking space sharing
between neighbours" in [ROADMAP.md](../ROADMAP.md)). It is built only on the
public plugin API, so it appears in the association's record of processing
activities (GDPR art. 30) the way every plugin does: from the `processing`
declaration in its manifest ([ADR 0035](adr/0035-a-plugin-s-processing-and-objecting-to-it.md)).
The records it keeps about people are declared as `personRecords`
([ADR 0047](adr/0047-a-plugin-s-records-about-a-person.md)).

This page is the wording of both. The plugin's author copies the declaration
into the manifest and the text keys into the plugin's locale files, and a change
to what the plugin does changes this page in the same pull request. A
declaration narrower than what the plugin does makes the association's record,
and the consent its board gave, wrong ([plugin contract](plugin-contract.md)).

> **Not legal advice.** The maintainers wrote this to fix what the plugin may
> do before it is built. The points in [Open points](#open-points) need an
> answer before the module is listed in the catalog.

## What the module processes

| What                                                   | About whom                      | Kept in                             |
| ------------------------------------------------------ | ------------------------------- | ----------------------------------- |
| Which space belongs to which household's member        | The person the board assigns it | `host.personRecords`, `assignments` |
| An offer: space, first and last day, withdrawn or not  | The person who offers           | `host.personRecords`, `offers`      |
| A claim: space, first and last day, cancelled or not   | The person who claims           | `host.personRecords`, `claims`      |
| The spaces themselves: a label, nothing about a person | Nobody                          | `host.records` (ADR 0033), `spaces` |
| An audit entry for each offer, claim and withdrawal    | The actor, and the person       | `host.audit` (ADR 0035, ADR 0047)   |
| A confirmation mail to the holder and to the claimer   | The person mailed               | Not kept; sent through `host.mail`  |

The plugin reads names, apartments and email addresses from the address book to
show the board an overview and to send the confirmations. It stores none of
them: a record names a person by id and refers to the register for the rest
(ADR 0047, "The record refers to the register and does not copy it").

A neighbour sees an open offer as a space label and dates. Neither the holder
nor the claimer is named to the other, in the screens or in the mail. The board
sees both. It handles no money: a payment between neighbours would be a taxable
supply needing an invoice (ADR 0011) and is outside the module.

## The entry in the record of processing activities

This is what the board reads on the data protection screen after installing, in
the association's language. The board's own edits there keep winning over it.

| Field                  | Swedish                                                                                                                                                                                 | English                                                                                                                                                                                |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Name                   | Parkeringsdelning                                                                                                                                                                       | Parking share                                                                                                                                                                          |
| Purpose                | Låta en boende erbjuda sin parkeringsplats under en period när den inte används och en granne ta den, samt ge styrelsen en översikt över platserna, erbjudandena och bokningarna.       | Let a resident offer their parking space for a period when it is not used and a neighbour claim it, and give the board an overview of the spaces, offers and claims.                   |
| Legal basis            | Avtal (art. 6.1 b), på samma grund som bokningar av gemensamma resurser.                                                                                                                | Contract (art. 6(1)(b)), on the same basis as bookings of shared resources.                                                                                                            |
| Data subjects          | Medlemmar och boende.                                                                                                                                                                   | Members and residents.                                                                                                                                                                 |
| Personal data          | Namn, lägenhet, e-postadress.                                                                                                                                                           | Name, apartment, email address.                                                                                                                                                        |
| Retention              | Ett erbjudande och en bokning raderas ett år efter den period de gäller. En tilldelning av plats raderas senast fem år efter att den gjordes, eller tidigare om styrelsen tar bort den. | An offer and a claim are erased a year after the period they cover. An assignment of a space is erased five years after it was made at the latest, or earlier if the board removes it. |
| Recipients             | Ingen utanför föreningen. Bekräftelser skickas från föreningens egen e-postserver.                                                                                                      | None outside the association. Confirmations are sent from the association's own mail server.                                                                                           |
| Third-country transfer | Nej. Modulen anropar inga externa tjänster.                                                                                                                                             | No. The module calls no external service.                                                                                                                                              |

Three things in the row are the platform's and not the plugin's to choose:

- **Erasure on request.** A granted erasure request deletes the person's
  records in all three collections at the next run of the host's purge, and the
  closing job does not close the request while one is left (ADR 0047). A legal
  hold or a restriction keeps them.
- **Restriction, protected personal data and objection.** A person with
  protected personal data, a person under a restriction and a person with a
  standing objection to this processing never appear in what the plugin reads.
  They cannot offer or claim, and the plugin tells them only that the module is
  not available to them and that they can ask the board.
- **The access report.** Each record is printed on the person's data subject
  access report under the collection's title, whether the plugin is running,
  switched off or removed.

## The declaration for the manifest

```jsonc
{
  "openbrf": {
    "id": "parking-share",
    "personalData": ["name", "apartment", "email"],
    "processing": {
      "purpose": {
        "sv": "Låta en boende erbjuda sin parkeringsplats under en period när den inte används och en granne ta den, samt ge styrelsen en översikt över platserna, erbjudandena och bokningarna.",
        "en": "Let a resident offer their parking space for a period when it is not used and a neighbour claim it, and give the board an overview of the spaces, offers and claims.",
      },
      "legalBasis": "contract",
      "retention": {
        "sv": "Ett erbjudande och en bokning raderas ett år efter den period de gäller. En tilldelning av plats raderas senast fem år efter att den gjordes, eller tidigare om styrelsen tar bort den.",
        "en": "An offer and a claim are erased a year after the period they cover. An assignment of a space is erased five years after it was made at the latest, or earlier if the board removes it.",
      },
      "dataSubjects": ["members", "residents"],
    },
    "personRecords": [
      {
        "collection": "assignments",
        "titleKey": "records.assignments.title",
        "personalData": ["apartment"],
        "keepAtMostDays": 1830,
        "fields": [{ "key": "space", "labelKey": "records.assignments.space" }],
      },
      {
        "collection": "offers",
        "titleKey": "records.offers.title",
        "personalData": ["apartment"],
        "keepAtMostDays": 730,
        "fields": [
          {
            "key": "space",
            "labelKey": "records.offers.space",
            "provided": true,
          },
          {
            "key": "from",
            "labelKey": "records.offers.from",
            "provided": true,
          },
          { "key": "to", "labelKey": "records.offers.to", "provided": true },
          { "key": "status", "labelKey": "records.offers.status" },
        ],
      },
      {
        "collection": "claims",
        "titleKey": "records.claims.title",
        "personalData": ["apartment"],
        "keepAtMostDays": 730,
        "fields": [
          {
            "key": "space",
            "labelKey": "records.claims.space",
            "provided": true,
          },
          {
            "key": "from",
            "labelKey": "records.claims.from",
            "provided": true,
          },
          { "key": "to", "labelKey": "records.claims.to", "provided": true },
          { "key": "status", "labelKey": "records.claims.status" },
        ],
      },
    ],
  },
}
```

Why the declaration is what it is:

- **`personalData` has three categories.** `name` and `apartment` are what the
  board's overview shows and what the address book gives for the caller.
  `email` is the address a confirmation is sent to, read with
  `addressBook:readContact`. `residency` is not declared: the plugin never
  reads or stores a move-in or move-out date, only whether the address book
  lists the person. `freeText` is not declared: no field takes a note.
- **Every collection declares `apartment` and nothing else.** ADR 0047 lets a
  collection name only the manifest's own categories, and a record's space and
  dates have no category of their own until the shared list proposed in the
  broker package's gap G11 exists. A space is tied to an apartment by whoever
  holds it, so `apartment` is the nearest.
- **`keepAtMostDays` for offers and claims is 730.** A record is erased a year
  after its period ends, and the plugin refuses an offer whose last day is more
  than 365 days after the day it is posted, so the longest `eraseOn` is
  365 + 365 days from the write.
- **`keepAtMostDays` for assignments is 1 830,** the longest ADR 0047 allows.
- **Only the holder's and the claimer's own choices are `provided`.** The
  space and the days travel in the portability export. A status the plugin
  sets, and an assignment the board made, do not.
- **The plugin declares no `network` hosts and no secret settings** (ADR 0037),
  which is what the third-country row states.

## The consent screen

Before anything is downloaded the board reads the permissions, the categories
and, for each collection, its categories and its bound (ADR 0047). The copy the
module supplies for them is below. The permission names are the plugin's
manifest `permissions`, shown by the host and not worded by the plugin.

| Shown                    | Value                                                                 |
| ------------------------ | --------------------------------------------------------------------- |
| Permissions              | `addressBook:read`, `addressBook:readContact`, `mail:send`, `actions` |
| Personal data            | Name, apartment, email address                                        |
| Collection `assignments` | Apartment. Kept at most 1 830 days.                                   |
| Collection `offers`      | Apartment. Kept at most 730 days.                                     |
| Collection `claims`      | Apartment. Kept at most 730 days.                                     |
| Legal basis              | Contract                                                              |

The plugin's description in the catalog entry, which the consent screen shows
beside these, says what the board is agreeing to in a form a resident can be
given:

> **English.** Parking share lets a resident offer their parking space for a
> period when they will not use it, and lets a neighbour claim it. The board
> assigns each space to a member or resident and sees every offer and claim.
> Neighbours see only the space and the days, never who the holder or the
> claimer is, and the module sends each of them a confirmation by email. It
> handles no payment. Records are erased a year after the period they cover.
> One thing to tell residents: an offer shows that a space is free on certain
> days, so a neighbour who knows whose space it is can tell the household is
> away.

> **Svenska.** Parkeringsdelning låter en boende erbjuda sin parkeringsplats
> under en period när den inte används, och låter en granne ta den. Styrelsen
> tilldelar varje plats till en medlem eller boende och ser alla erbjudanden och
> bokningar. Grannar ser bara platsen och dagarna, aldrig vem som erbjuder eller
> tar platsen, och modulen skickar en bekräftelse till båda med e-post. Ingen
> betalning hanteras. Uppgifterna raderas ett år efter den period de gäller.
> Något att berätta för de boende: ett erbjudande visar att en plats är ledig
> vissa dagar, så en granne som vet vems plats det är kan se att hushållet är
> bortrest.

## Text keys

The keys are in the plugin's own namespace, as everywhere in the manifest. The
audit events are shown in the audit log through `audit.<event>` (ADR 0035).

| Key                         | Swedish                   | English                |
| --------------------------- | ------------------------- | ---------------------- |
| `records.assignments.title` | Tilldelad parkeringsplats | Assigned parking space |
| `records.assignments.space` | Plats                     | Space                  |
| `records.offers.title`      | Erbjuden parkeringsplats  | Offered parking space  |
| `records.offers.space`      | Plats                     | Space                  |
| `records.offers.from`       | Första dag                | First day              |
| `records.offers.to`         | Sista dag                 | Last day               |
| `records.offers.status`     | Status                    | Status                 |
| `records.claims.title`      | Tagen parkeringsplats     | Claimed parking space  |
| `records.claims.space`      | Plats                     | Space                  |
| `records.claims.from`       | Första dag                | First day              |
| `records.claims.to`         | Sista dag                 | Last day               |
| `records.claims.status`     | Status                    | Status                 |
| `audit.space-assigned`      | Plats tilldelad           | Space assigned         |
| `audit.space-unassigned`    | Tilldelning borttagen     | Assignment removed     |
| `audit.offer-posted`        | Plats erbjuden            | Space offered          |
| `audit.offer-withdrawn`     | Erbjudande återtaget      | Offer withdrawn        |
| `audit.space-claimed`       | Plats tagen               | Space claimed          |
| `audit.claim-cancelled`     | Bokning avbruten          | Claim cancelled        |

An audit entry names the person it is about through `subject`, and its detail
holds the space label and the dates, never a name, an apartment or an address.

## What the plugin has to do to match

Each line is a rule the declaration relies on. A review of the plugin checks it
against the code.

1. A record is written with `eraseOn` one year after the offer's last day and
   `host.personRecords` is the only place a person's id and a date are kept
   together. Nothing about a person goes in `host.records` or in the plugin's
   settings.
2. An offer whose last day is more than 365 days after the day it is posted is
   refused with a message, not shortened.
3. Who is calling comes from `host.addressBook.caller`. A caller who is
   `notListed` gets one message for every reason, as ADR 0047 requires, and
   cannot offer, claim or assign.
4. A neighbour's list of open offers carries a space label and dates. It does
   not carry a person id, a name or an apartment, in the response or in
   anything else the page loads.
5. A confirmation mail names the space and the days. It does not name the other
   person or give an address or telephone number.
6. The first claim wins, and the store refuses the second with a conflict on
   the offer's key (`expectedRevision: null`), not a check the plugin makes
   first.
7. Withdrawing an offer and cancelling a claim set a status and keep the record
   to its date. They do not call `delete`, so the audit entry and the access
   report agree about what happened.
8. The plugin makes no outbound request and stores no name, address or
   telephone number it read from the address book.

## Open points

1. **The legal basis.** Contract follows the core's bookings and events
   (`bookings` in `processing-activity-seed.ts`) and the glossary's
   reasoning that a booking is the service the resident is entitled to as a
   member or resident. A paid, optional neighbour-to-neighbour service is not
   part of the membership, so a lawyer may prefer legitimate interest (which
   adds the right to object, already supported by ADR 0035 and needing
   `legitimateInterest` text) or consent (which makes a withdrawal end the
   claim). The choice also decides whether the portability export carries the
   records: it does under consent or contract and does not under legitimate
   interest (ADR 0047). **Reasoned.** To confirm before listing.
2. **Where the space-to-person assignment lives.** The plan has the board
   enter which apartment holds which space. This page declares it as the
   `assignments` person collection with the holder as subject, because an
   apartment id tied to a space says who the holder is and ADR 0033 keeps
   `host.records` free of that. The cost is that the record goes when the
   holder is erased, moves out and is no longer rewritten, or after 1 830 days,
   and the board then assigns the space again. The alternative, a space label
   alone with no holder, would make the module unable to know who may offer
   what. **Open** for the CTO and the plugin's author.
3. **The offer reveals absence.** The module shows neighbours only a label and
   dates, but a label that the car park's own signs show is enough for a
   neighbour to know whose space it is. The consent copy says so. Whether the
   board may hide the label until a neighbour opens an offer, or only show
   offers to those who have no space themselves, is a design decision for the
   plugin's view. **Open** for the plugin's view (task E).
4. **Former residents.** `dataSubjects` offers `members` and `residents` only.
   A person who has moved out keeps their records to the erase date and they
   appear on their access report, but the record of processing does not list
   former residents as a data subject category for a plugin. This is how
   ADR 0035 words it and is not changed here. **Open** for a later revision of
   the manifest field.
5. **The categories.** `apartment` stands in for a space and a date range until
   the shared list of categories exists (ADR 0047, "Consequences").
6. **Not yet checkable by the build.** `parsePluginPackage` does not read
   `processing` or `personRecords` yet, because the host side of ADR 0035 and
   ADR 0047 is not built. The parking-share repository validates this block
   against the manifest schema in its own build when it lands.

# The broker package: design note and gap audit

A design note for a paid module that is not built yet: the broker extract
(mäklarbild) a broker orders and pays for, which the association's board
reviews and releases. It says what the document holds, how an order reaches an
instance and how a release leaves it, and - the part that matters for the core

- every place the public plugin API cannot carry it today. Each of those is
  proposed below as a free core change.

Nothing here is a contract yet. The plugin contract
([plugin-contract.md](plugin-contract.md)) and the action rules
([actions.md](actions.md)) stay authoritative, and each core change proposed
here lands in them in its own pull request. Whether the data flow is lawful,
and on which basis, is a legal question this note does not answer; where the
design depends on that answer it says so.

## What is free and what is paid

Free, in the core, and unchanged by anything below:

- the public broker information page (mäklarinfo), generated from the
  association facts the board records;
- the date the board last confirmed those facts, and a broker's request for an
  update once they are older than three months. Both are core because they make
  the free page honest;
- every statutory answer: the tenant-owner's own extract of the apartment
  register (BRL 9 kap.), which the tenant-owner can hand to whoever they like.

Paid: the ordered, packaged and delivered broker extract, and the service Apteo
runs around it - taking the order, charging the broker, delivering the
document. That is the clause that makes a module paid: a service somebody runs.

The package must never become the only way to answer a broker. A board that
does not buy it answers from the broker page and the tenant-owner's own
extract, as it does today, and the end-to-end test of the package includes that
case with the plugin absent.

## Principles

- **The instance never sends on its own.** An order arrives; a person decides.
  Nothing leaves before a board member releases it, and nothing is released by
  a timer, a rule or a default.
- **The plugin drafts from what the core already records,** through the public
  plugin API and core actions, and keeps nothing of its own at rest (see
  [What the instance keeps](#what-the-instance-keeps)).
- **Every disclosure is declared and audited.** No personal data leaves an
  instance without a `personalData` declaration the board consented to and an
  audit entry naming the people it concerns.
- **No private hooks.** Every gap below is proposed as general API, documented
  in the contract, open to any plugin and naming neither this package nor
  Apteo.

## Who takes part

| Party                                 | What they do                                                                                                                       |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| The broker                            | Orders an extract for one apartment from Apteo's service and pays for it there. Never has an account on the instance.              |
| Apteo's service                       | Holds the order, charges the broker, delivers the released document and refunds a refused or lapsed order. Holds no register data. |
| The tenant-owner (bostadsrättshavare) | Consents to the disclosure of their apartment's entry, each joint holder for themselves (subject to the legal answer).             |
| A board member                        | Matches the order to an apartment, reviews the draft, releases or refuses.                                                         |
| The instance (core and the plugin)    | Fetches open orders, drafts the document from recorded facts, sends what was released, writes the audit entries.                   |

A property manager (förvaltare) takes no part. The role reaches issue handling
and nothing else, and releasing register content is not issue handling.

## What the document holds

One PDF per order, about one apartment, rendered inside the instance so that
the bytes the board previewed are the bytes that leave.

| Part            | Item                                                                                                                                                 | Source                                                                                                     | Personal data                |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ---------------------------- |
| The association | Name and organisation number                                                                                                                         | Core action, after [G4](#g4-the-associations-identity-and-the-confirmation-date-in-the-facts-action)       | none                         |
| The association | Property designation as published, year built, site leasehold and its note, what the fee covers and the board's fee policy                           | `association_facts_get` (exists)                                                                           | none                         |
| The association | Transfer fee and pledge fee policies, juridical persons as members, parking, storage, renovations                                                    | `association_facts_get` (exists)                                                                           | none                         |
| The association | Number of apartments                                                                                                                                 | `host.addressBook.summary()` (exists)                                                                      | none                         |
| The association | The date the board last confirmed the facts                                                                                                          | Core field, read through [G4](#g4-the-associations-identity-and-the-confirmation-date-in-the-facts-action) | none                         |
| The apartment   | Apartment number, address, floor                                                                                                                     | `host.addressBook.apartments()` (exists)                                                                   | none on its own              |
| The apartment   | The tenant-owners' names                                                                                                                             | [G2](#g2-an-apartment-register-entry-for-a-disclosure)                                                     | `name`, `apartment`          |
| The apartment   | Participation share (andelstal) and initial share capital (insats)                                                                                   | [G2](#g2-an-apartment-register-entry-for-a-disclosure)                                                     | `financial`                  |
| The apartment   | Open lien notes: creditor, the day noted, the amount where recorded                                                                                  | [G2](#g2-an-apartment-register-entry-for-a-disclosure)                                                     | `financial`                  |
| The apartment   | Monthly fee in force, and a rate the board has already dated forward                                                                                 | [G3](#g3-the-fee-in-force-for-one-apartment)                                                               | none: fixed on the apartment |
| Statements      | Released by the board of the association on a date; the order reference; that the facts are the board's own statements as of their confirmation date | The release itself                                                                                         | none                         |

The tenant-owners' names come from the apartment register and never from the
plugin address book. The address book leaves out a person with protected
personal data (skyddade personuppgifter) and a person under a restriction
(begränsning av behandling) altogether - absent, not masked - so a joint
holding read from it would print as a sole one, and the document would state
something false about who holds the apartment.

What the document never holds:

- a personal identity number, of anybody;
- a contact detail, of anybody;
- residents who are not tenant-owners, and anything about a household;
- anything about payment: whether the fees are paid, arrears, a balance. Core
  records no payment ([ADR 0011](adr/0011-fees-and-notices.md)), so the
  document says the association's books answer that question, and names
  nobody who keeps them;
- the member register, subletting, issues, the apartment binder and the
  board's own correspondence;
- the free text of a broker's request for updates.

Alteration permissions (tillstånd till ändring) are what a broker asks about
next. They sit in the apartment binder, and reading the binder for somebody
outside the household is a question of its own; they are left out of the first
version rather than added on the same consent.

Lien notes are what the association's own apartment register records. Once the
cooperative housing register (bostadsrättsregistret) takes over liens under Lag
(2026:484), the lienholder reports them to Lantmäteriet and that register is
the authority; the document says which of the two the figures come from.

## The order protocol

The instance asks; the service answers. The plugin fetches open orders from
Apteo's service on a schedule (`jobs:schedule`) and when a board member opens
its screen. The service never calls the instance.

Pull is the protocol this note chooses, for two reasons. A self-hosted
instance commonly has no public inbound address at all, the same reason the
board mailbox collects over POP3 rather than receiving mail; and the platform
has no general webhook facility, so a push would need a new entry point into
the process that holds the member register, where a pull needs none.

The platform does not rule a push out by itself, but it offers nothing to build
one on. An ordinary plugin route is mounted inside the session guard and
`@Public()` has no effect on it, so a service cannot call one without a
member's session. The one exception is the route a plugin declares as its
`oauthProtectedResource`, which with its descendants takes a Bearer token
instead of a session ([plugin-contract.md](plugin-contract.md)). That is the
instance's single OAuth resource, there for sign-in by an MCP client, and
reusing it for a service's calls would be the wrong use of it.

### Enrolment

The association's administrator enrols the instance once: Apteo's service
issues a token bound to the association's organisation number, and the
administrator enters it in the plugin's settings. The token is the instance's
only credential with the service, so it is held as a secret setting
([G10](#g10-a-secret-settings-field)) and never shown again. Removing the
plugin or clearing the setting ends the enrolment from the instance's side.

### Messages

Versioned under `/v1`; a plugin refuses a major version it does not know. Every
request carries the token and nothing else that identifies the instance.

| Request                                | Direction                      | Carries                                                                                                                                                                                                                                                                                  |
| -------------------------------------- | ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /v1/orders?state=open`            | instance asks, service answers | The open orders: order id, created and lapse instants, the apartment as the broker stated it (street, number, apartment number), the broker firm's name and organisation number, the broker's name, email address and telephone number (the last two optional, nothing else about them). |
| `POST /v1/orders/{id}/acknowledgement` | instance to service            | Nothing but the order id. Marks the order seen, so the board is notified once per order without the instance remembering anything.                                                                                                                                                       |
| `POST /v1/orders/{id}/delivery`        | instance to service            | The released PDF and its sha512, the facts' confirmation date and the release date. The only request that carries register data.                                                                                                                                                         |
| `POST /v1/orders/{id}/refusal`         | instance to service            | One reason code: `not-for-sale`, `consent-missing`, `not-our-apartment`, `withheld`, `other`. No free text.                                                                                                                                                                              |

Every `POST` is idempotent on the order id, and the service refuses a second
delivery or a delivery after a refusal. An order nobody answers lapses at the
service after a stated period (14 days is the proposal) and is refunded; the
instance does nothing to make it lapse.

The broker's own details arrive with the order: name, email address and
telephone number, and the response permits no other field about them. They are
shown to the board on the order screen and never stored: they are personal data
about somebody outside the association (the `external` data subject category),
and the association needs them only for as long as it is deciding. Showing them
is still processing, so the plugin declares their categories (`name`, `email`
and `phone`) in its own `personalData` below, which is what the consent screen
and the record of processing activities read. The outbound recipient
declaration lists only what is sent to it, and the broker's details are not.

### What the service keeps

The service holds the order and its payment for its own accounting. It holds
the document only until it is delivered to the broker, and for no more than a
short stated window if the broker never collects it; then the document is
deleted and the service keeps its digest. It keeps no other association data.
Whether Apteo is a processor or an independent controller for the delivery
decides which agreement the association needs, and that answer belongs to the
legal review rather than to this note.

## The release flow

1. **An order appears.** The scheduled fetch finds an order it has not
   acknowledged, notifies whoever holds `apartmentRegister:read`
   ([G8](#g8-notifying-the-holders-of-a-capability-or-one-person)), and
   acknowledges it. The overview counts open orders for the same people
   ([G9](#g9-a-plugins-queue-on-the-overview)).
2. **A board member matches the apartment.** The order screen shows the
   apartment as the broker wrote it beside the instance's own list of
   apartments, and the board member picks one. Nothing is matched
   automatically: a broker's text is untrusted input, and a near match is
   exactly how the wrong apartment's entry would be sent.
3. **The tenant-owners consent.** Each current tenant-owner of the matched
   apartment is told an order is waiting ([G8](#g8-notifying-the-holders-of-a-capability-or-one-person))
   and consents, or does not, to the disclosure of the apartment's entry to the
   broker firm the order names
   ([G5](#g5-a-recorded-consent-to-disclose-to-a-named-recipient)). This step
   is the answer to the misuse the plan names - a broker ordering for an
   apartment that is not for sale - and its exact legal form waits on the legal
   review.
4. **The plugin drafts.** Its route, serving the board member's request,
   dispatches the core actions as that board member: the facts, the fee, and
   the apartment's register entry for a disclosure. The draft is rendered to
   PDF and shown, with its sha512.
5. **The board member releases or refuses.** Release posts the preview's
   digest back; the plugin renders again from the same inputs and refuses if
   the bytes differ, so a fact edited between preview and release is shown
   before it is sent rather than after. The document is sent through the
   declared recipient ([G6](#g6-a-declared-and-audited-recipient)). A refusal
   sends a reason code and nothing else.

A release is refused, with the reason on the screen, when:

- the register entry is withheld because a tenant-owner has protected personal
  data or is under a restriction. The package cannot be used for that
  apartment; the board answers by hand, as it would without the package;
- any current tenant-owner has not consented, or has withdrawn;
- the board member releasing it holds a residency on the apartment. Someone
  selling their own apartment does not also release its extract;
- the order is no longer open at the service;
- the board member does not hold the capabilities the core actions require.

Facts older than the three-month threshold do not block a release. The screen
says how old they are, and the document prints the date they were last
confirmed.

### What is audited

| Event                      | Entry                                                                                                                                                                                                                                         |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Register entry read        | Written by the core action for the read on the `plugin` audit channel, as the board member.                                                                                                                                                   |
| Document sent              | Written by the host for the disclosure ([G6](#g6-a-declared-and-audited-recipient)): one entry per tenant-owner as the target person, with the recipient, the broker firm's organisation number, the categories, the digest and the order id. |
| Release or refusal decided | Written by the plugin through the host ([G7](#g7-audit-entries-written-by-a-plugin)): the board member, the apartment, the order id and the reason code.                                                                                      |
| Consent given or withdrawn | Written by the core consent record ([G5](#g5-a-recorded-consent-to-disclose-to-a-named-recipient)).                                                                                                                                           |

The disclosure entries name the tenant-owners as target persons, so each
tenant-owner's data subject access report shows who received their entry and
when (GDPR art. 15(1)(c)). The audit log is never purged, which is why no entry
carries the broker's own name: the broker firm is a juridical person and its
organisation number is not personal data, while the broker's name stays with
the order at the service.

### What the instance keeps

Nothing in the plugin. The order is the service's, the consent is the core's,
the record of what was sent is the audit log's, and the draft is rendered on
demand. The plugin therefore needs no store of its own, no retention window and
no section in the data subject access report, which is a smaller thing to get
right than any of those. If building it shows the plugin does need to keep
something, that is a further core change, not a table of the plugin's own.

## The manifest the package would declare

```jsonc
{
  "openbrf": {
    "apiVersion": 1,
    "id": "broker-extract",
    "permissions": ["addressBook:read", "mail:send", "jobs:schedule"],
    "personalData": ["name", "apartment", "financial", "email", "phone"],
    // Proposed fields, from the gaps below:
    "dispatches": [
      "association_facts_get",
      "apartment_fee_get",
      "apartment_register_disclosure_get",
    ],
    "recipients": [
      {
        "id": "broker-service",
        "origin": "https://<service origin>",
        "purposeKey": "recipients.brokerService.purpose",
        "personalData": ["name", "apartment", "financial"],
      },
    ],
    "auditEvents": ["release-decided", "refusal-decided"],
    "settingsSchema": {
      "fields": [
        {
          "key": "serviceToken",
          "labelKey": "settings.token",
          "type": "secret",
        },
      ],
    },
  },
}
```

The action names are working names; each core task fixes its own against
[actions.md](actions.md).

## Gaps in the public plugin API

Every gap is a free core change, general rather than made for this package, and
documented in the plugin contract or the action catalogue when it lands. Size
is a guess: S is a day or two, M under a week, L more.

### G1. Declared dispatch of core actions

**Gap.** `host.actions.invoke` reaches every core action the person on the
other end of the request may call. The registry's surface check passes a core
action unconditionally, and nothing in the manifest says which core actions a
plugin dispatches, so the consent screen cannot show it and a republished
version can start dispatching a new one unseen.

**Proposal.** A manifest field `dispatches`: the core action names the
plugin's routes invoke. Shown on the consent screen with each action's
capability and personal-data categories; a core action outside it is refused
by `invoke`; a republished version that adds one is held as a widening, like
`actions-widened`. The categories of the dispatched actions must fall inside
the plugin's own `personalData`.

**Acceptance.** Undeclared dispatch refused with a test; consent screen lists
the field; widening finding; contract updated. The example plugin and the
catalog listings are checked first, and if any dispatches a core action today
the refusal lands a release after the field. **M.**

### G2. An apartment register entry for a disclosure

**Gap.** Nothing in the plugin API reads the apartment register, and that is
deliberate: no plugin permission reaches it. There is no core action for it
either, and `ApartmentRegisterService` is on `DENIED_ACTION_SERVICES` because
it writes the register.

**Proposal.** A core read action for one apartment's entry, for disclosure to a
named recipient: the tenant-owners' names, participation share, initial share
capital and open lien notes, and never a personal identity number. Capability
`apartmentRegister:read`, surfaces `["ui"]` only, so it is never offered to a
connected app or the AI package, and reachable by a plugin only through G1. It
is bound to a read-only service split out of the register service, so the
denylist stays as it is. An apartment with any tenant-owner who has protected
personal data or is under a restriction answers with a withheld branch, not
with a shorter list, which also means it never needs the `protected`
category. Once G5 lands it refuses without a standing consent from every
current tenant-owner naming the recipient. Each read is audited.

**Acceptance.** Withheld branch tested for protected and restricted holders,
joint holdings included; no identity number in the output, by the contract
test; denylist unchanged and the contract test still sweeping the registrar;
audit entry on the `plugin` channel. **M.**

Not proposed: a plugin permission such as `apartmentRegister:read` on the host
object. It would hand the whole register to a plugin's code at any time; an
action dispatched as a board member reaches one apartment, under that person's
capability, at the moment they ask.

### G3. The fee in force for one apartment

**Gap.** No core action reads an apartment's fee.

**Proposal.** A core read action returning the monthly fee in force for one
apartment and kind, and any rate already dated forward. Capability
`fees:manage`. It names nobody - the fee is fixed on the apartment - so its
personal data is `[]`.

**Acceptance.** Action in the catalogue with tests for a forward-dated rate and
an apartment with none. **S.**

### G4. The association's identity and the confirmation date in the facts action

**Gap.** `association_facts_get` returns the facts but not the association's
name and organisation number, and not the date the board last confirmed the
facts, which is being added to the core separately.

**Proposal.** Add the name, the organisation number and the confirmation date
to the action's output, additively, or add a small `association:read` action
for the identity if mixing the two reads badly. Either way the confirmation
date is in the facts action.

**Acceptance.** Output schema updated and published; tests. **S.**

### G5. A recorded consent to disclose to a named recipient

**Gap.** The core records publication consent (publiceringssamtycke) for
appearing on a public page, and nothing for a tenant-owner allowing their
apartment's register entry to go to a named outside party.

**Proposal.** A core record, held as consent records already are: granted by a
tenant-owner for their own apartment only, naming the recipient by
organisation number and name and the purpose, with an end date at most a
stated period ahead, withdrawn with a date and never deleted. Granted on the
tenant-owner's own screen and through a `self:manage` core action, so a plugin
can offer it in its own view under G1. It appears in the data subject access
report. G2 reads it. The Swedish and English terms go into GLOSSARY.md with the
code.

**Blocked by** the legal review. If the answer is that the basis is something
other than consent - the seller's instruction, a contract, a legitimate
interest - the record is of that, and the name follows. **L.**

### G6. A declared and audited recipient

**Gap.** A plugin can open any connection it likes - it runs at full process
privilege (ADR 0003) - but there is no host path for sending personal data out
that the board consented to, that the host audits, and that goes through the
instance's outbound address rules. The consent screen asks the board whether a
plugin sends personal data outside the instance and to whom, and the manifest
cannot say.

**Proposal.** A manifest field `recipients`: each an id, an `https` origin, a
purpose text key and the personal-data categories it receives, shown on the
consent screen and pre-filling the recipient question there (the board still
classifies processor or controller). `host.recipients.send(id, request)` sends
to that origin only, through the outbound address rules, after writing one
audit entry per person the request names as concerned, with the recipient, the
categories, the body's digest and the outcome. A request that names categories
outside the recipient's declaration is refused before anything is sent. The
same object carries the plugin's requests that send no personal data, such as
fetching orders, so they go through the same rules. The catalog's listing rules
gain one: a listed plugin that sends personal data does so through this and
nothing else, which the reviewer reading the server bundle checks.

**Acceptance.** Origin and category refusals tested; audit entry before the
send and its outcome after; record of processing activities lists the
recipient; widening finding for a new recipient; contract updated. **L.**

### G7. Audit entries written by a plugin

**Gap.** A plugin cannot write to the audit log. `AuditLogService` is a core
provider a plugin may not inject, and `AuditAction` is a closed enum.

**Proposal.** `host.audit.record(request, entry)`: one new audit action for
plugin events, with the plugin id, an event code the manifest declared under
`auditEvents`, optional target persons and apartment, and a small detail of
ids and codes only - no free text, because the log is never purged. The actor
and the audit channel come from the request, as dispatch already does.

**Acceptance.** Undeclared event refused; free text refused; the entry shows in
the data subject access report of a target person. **M.**

### G8. Notifying the holders of a capability, or one person

**Gap.** `mail:send` needs an address, and a plugin has none for the board -
board positions are not on the host object - and reading every resident's
address (`addressBook:readContact`) to reach two tenant-owners is far more than
it needs.

**Proposal.** `host.notify`: to the current holders of a named capability, or
to one person the plugin already knows by id from the address book, in each
recipient's own language and the house mail style. The host resolves the
addresses and the plugin never sees them. Requires `mail:send`.

**Acceptance.** No address returned to the plugin; a person under an objection
or a restriction handled by the same rules as core mail of the same kind; tests.
**M.**

### G9. A plugin's queue on the overview

**Gap.** The overview counts what is waiting in each queue for whoever works
it, and only for core queues.

**Proposal.** A manifest field naming a queue, the capability that sees it, its
title key and the plugin view it opens; the plugin supplies the count through
the host. The overview shows it beside the core queues to holders of the
capability. A count that fails or is slow is left out rather than holding the
overview up.

**Acceptance.** Count shown only with the capability; a failing count does not
break the overview; tests. **M.**

### G10. A secret settings field

**Gap.** Settings have `text`, `number`, `boolean` and `select`. A credential
entered as text is stored as written and shown back on the admin screen.

**Proposal.** A `secret` field type: encrypted at rest with the field
encryption the core already uses (ADR 0002), never returned to the browser
(the screen shows whether it is set), returned in clear only by
`host.settings.read()` on the server, and recorded as a settings change in the
audit log without its value.

**Acceptance.** Value never in an API response or the audit log; round trip
tested. **S to M.**

### G11. The personal-data categories a plugin may declare

**Gap.** A manifest's `personalData` takes five categories (`name`,
`apartment`, `residency`, `email`, `phone`). An action's takes fourteen. The
package handles `financial`, which a plugin cannot declare at manifest level.

**Proposal.** Take the manifest's list from the same shared categories the
record of processing activities uses. The catalog index reads that field with
the same enum, and an instance refuses an index carrying an entry it cannot
read, so this is a new index `version`, with the catalog's check updated
alongside.

**Acceptance.** New categories accepted in the manifest and the catalog;
consent screen labels for each; old instances unaffected by the version bump.
**S.**

### Already planned

Plugin views in the navigation is already on the roadmap. The package needs it
for the board's order screen.

### Considered and not proposed

- **An unauthenticated inbound route for plugins.** The pull protocol needs
  none, and it would be the first entry point into the process outside the
  session guard.
- **Widening `PLUGIN_ELIGIBLE_CAPABILITIES`.** The release is a plugin route
  that requires `apartmentRegister:read` with `@RequireCapability`, which a
  route may already do. It does not need to be an action a connected app could
  reach.
- **A store of the plugin's own.** See [What the instance keeps](#what-the-instance-keeps).
- **A release by a property manager.** See [Who takes part](#who-takes-part).

### Order of work

G10, G11, G3 and G4 are small and independent. G1, G7 and G6 come next,
because G2 and every disclosure stand on them. G2 then, and G5 when the legal
review has answered. G8 and G9 can go at any point before the plugin itself.
The plugin is built after all of them, against the contract as it then stands.

## Open questions

- **The legal basis** for disclosing the entry, the shape of the tenant-owner's
  part in it, and whether Apteo is a processor or a controller for the
  delivery. This decides G5 and the agreement the association needs.
- **Signing.** Whether the service seals the delivered document, and if so
  that the seal attests delivery by Apteo while the content stays the
  association's statement.
- **The lapse period** for an unanswered order, and how long the service keeps
  an undelivered document.
- **Alteration permissions** in a later version, and on what consent.

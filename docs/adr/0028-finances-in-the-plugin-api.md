# ADR 0028: Finances in the plugin API - a read, a receipt and an event

Date: 2026-10-19

## Status

Proposed. Stands beside ADR 0011, which it does not change: a run and its
notices are still produced and never edited, and core still records no payment.

## Context

ROADMAP.md lists advanced finances as a paid module: posting to Fortnox and
Visma, autogiro and bankgiro files, payment reminders, a collections hand-off,
and an approval step before anything leaves. It also says every paid module is
built on the same public plugin API that is available to anyone.

That API could not carry the module. A plugin could read the address book, send
mail and text messages, and run jobs. It could not read a fee notice or a
charge, could not say that it had delivered one, and could not learn that one
had been issued. Building the module would have meant a private seam in core,
which the rule above forbids, or a module that polled for rows it had no
permission to read.

Three things in the product constrain the shape of the answer.

- **Core records no payment.** Not on the notice, not on the charge, and not in
  a status that stands in for one (ADR 0011, `docs/fee-notice-contract.md`).
  The accounting system settles the debt, and a second answer to whether
  something was paid is worse than none.
- **A protected person never reaches a plugin.** The address book leaves them
  out, not masked. The files the board hands over mask them differently: the fee
  notice file withholds a protected household's names, and the debiting list
  names a protected person and withholds where they live, because the
  bookkeeper has to know whom to invoice.
- **A run and its notices are accounting records** (bokföringslagen 1 kap. 2 § 9) from the moment they are written, and 7 kap. 1 § forbids altering what is
  preserved.

## Decision

### Two permissions and a host member

`finances:read` reads the runs, the notices and the charges and receives the
events. `finances:recordDelivery` writes a delivery receipt. They are separate
because one writes and the other does not, and a board consenting to a plugin
that reads the books should know it cannot add to them. A new personal-data
category, `financial`, lets a plugin declare that it handles what an apartment
is billed or a person charged.

`host.finances` carries both, and is feature-detected as `host.actions` is,
because `isSupportedApiVersion` cannot see a member added to the host. The
contract version stays 1.

### The read starts from the board's own files, and withholds more

The plugin read takes the rows the fee notice document and the debiting list
are written from, through the services that write those files, and maps them
field by field into the SDK's shapes. Whatever the files withhold, a plugin is
not given. Then it withholds more:

- a protected person is never named: a notice for their household withholds
  every name, and a charge on them withholds who, where and the board's reason;
- a person whose processing is restricted (GDPR art. 18) is withheld the same
  way, because handing their row to code the association installed is a use,
  and art. 18(2) permits storage rather than use. The files do not withhold
  them: billing a restricted member is the association keeping its own books;
- a charge whose person the register no longer holds is withheld rather than
  shown with an empty name.

A withheld value is its own branch, `{ state: "withheld" }`, never an empty
string. The date, the amount and the VAT treatment stay on a withheld charge, so
the books still add up and a plugin can leave the row for the board.

Mapping field by field means a column added to the board's documents for the
board's screen does not reach a plugin until somebody adds it to the SDK too.

Reads are not audited one by one. The plugin is consented code in the
instance's own process, and an entry per poll would bury the entries that say
something.

### A delivery receipt is a row of its own, and never a payment

`delivery_receipt` holds one plugin's record that one notice or one charge left
by a route (`channel`), at a time (`deliveredAt`), under a reference the
receiving system knows it by. Exactly one target, by a check constraint. It is
not a column on the notice: that would be a state on a row the law forbids
altering, and one value where there can be several.

- **No paid state.** No column says the money arrived, and nothing in core reads
  a receipt to decide anything.
- **Once per delivery.** Two partial unique indexes make the same plugin, target,
  channel and reference one receipt, and the host hands the first back on a
  retry.
- **Audited.** `DELIVERY_RECEIPT_RECORDED`, on the `PLUGIN` channel, naming the
  plugin, the route and the receipt but not the reference, which lives on the
  receipt and is erased with it. The subject is the person charged, so a
  delivery appears on their access report beside the charge.
- **Erased with its target.** Both foreign keys cascade, so the fee and charge
  purges take receipts along without knowing they exist, and so does the board
  removing a charge entered by mistake.
- **On the board's screen, not in the files.** The notice document shows a
  column of receipts that is not printed. The file is the notice; a receipt is a
  note about where a copy of it went.
- **Its reference withheld from a plugin with the row it is on.** The reference
  is a plugin's free text, refused only for a personal identity number. One
  built from a household's names while they could be shown, such as
  `Signe-Skyddad-2026-09`, would otherwise outlast the protection or the
  restriction applied after it, and reach every plugin that reads the finances,
  one installed later included.
  So a plugin's read withholds it on a notice whose holders are withheld and a
  charge whose party is, by the register at the read. The receipt itself stays,
  so a plugin can still tell the row was delivered and not deliver it twice; the
  board's screen keeps the reference.

### Events are enqueued with the act, one queue per plugin, identifiers only

`feeNotification.issued`, `memberCharge.recorded`, `memberCharge.corrected` and
`memberCharge.removed`, each with a version of its own. The writer enqueues
the event inside its own transaction, through pg-boss's transactional send, so
an act that rolled back never produces one and an act that committed always
does. Each listening plugin gets its own job on its own queue,
`plugin/<id>/finances/events`, so a plugin whose handler throws is retried
without redelivering to the others. Only a plugin that is serving and has
subscribed is sent to: its queue exists from the moment it subscribes, and a
send to a queue that does not exist would fail the board's own act.

An event carries the run's or the charge's id and nothing else, so it needs no
masking and is not a second copy of anything.

### Nothing to intercept in core, and issuing is not vetoable

The plan asked for an event a plugin could use to intercept delivery. Core
delivers nothing, so the event reaches the plugin before anything has left, and
an approval step is the plugin deciding what it delivers. Issuing itself stays
outside a plugin's reach: the run is an accounting record as soon as it is
written, and a hook able to refuse it would let a plugin decide what the
association has billed.

### The route floor becomes a list

A plugin route has always been raised to the capability its data permissions
imply. `finances:read` reads two halves the board holds under two capabilities,
`fees:manage` and `memberCharges:manage`, so the floor became a list the caller
must hold every entry of, for routes and for a plugin's actions alike.

### Credentials are not settled here

The module needs per-instance credentials: OAuth tokens, a bankgiro customer
number. A plugin setting is plain JSON, returned whole to the admin screen, and
not writable by the plugin, so it is no place for one. `docs/plugin-contract.md`
now says so. The store itself is separate work, already raised as a confirmed
gap in the plugin API audit for the AI package (proposed ADR "declared outbound
hosts and secret settings").

## Consequences

- A plugin can build the whole approval-and-delivery flow on the public API,
  without a private seam, and so can anyone else.
- A plugin delivering notices cannot deliver a protected or restricted
  household's by itself. That is deliberate: those rows are the board's to
  handle by hand, and the plugin sees that they exist.
- A plugin that was switched off, or had not subscribed, misses events and has
  to reconcile from the reads when it starts. The queue is not a log to replay.
- The board's documents carry `deliveries` and the notice row carries its
  `apartmentId`; the files they are written to do not change.

## Revisit triggers

- Core starts delivering notices itself. Then whether a plugin may hold a core
  delivery back is a real question, and this ADR's answer that there is nothing
  to intercept no longer holds.
- A plugin needs to correct or withdraw a receipt. Today a receipt is written
  once and goes with its target.
- Polling reads turn out to be a disclosure the log has to answer for, and reads
  need auditing after all.

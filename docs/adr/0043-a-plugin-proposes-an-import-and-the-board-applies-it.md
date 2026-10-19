# ADR 0043: A plugin proposes an import, and the board applies it

Date: 2026-10-19

## Status

Accepted. Nothing in it is implemented yet. It changes the rule "nothing is
writable" in [the plugin contract](../plugin-contract.md#permissions) in one
place and no other: a plugin may hand the core a member list to review. A
plugin still writes nothing to the register.

## Context

A housing cooperative's member list often lives somewhere else first: in the
economic manager's system (ekonomisk förvaltare), or in a spreadsheet a board
member keeps up to date. The core imports such a list from CSV or Excel, in four
steps the board takes on the import screen: upload, map the columns, look at
what would happen, apply (`apps/api/src/import/import.service.ts`). The third
step is the reason for the other three. An import writes the statutory member
register, which the database will not let anyone update or delete, so the board
sees every row that would be created and every match that would be made before
any of it happens.

Two kinds of plugin want to bring that list in without a board member uploading
it by hand:

- one that receives the file by email: the association mails its list to an
  address, and a relay run by the plugin's publisher passes the file on;
- one that fetches the list from a manager's system on a schedule.

Neither can do it today. A plugin reads the register through a narrow host
object and writes nothing (`packages/plugin-sdk/src/permissions.ts`; "A plugin
that needs to change resident data is a core feature request, not a plugin").
It cannot inject the database or the import service (`forbidden-injection`).
And it should not apply anything on its own: an import a board member did not
look at is exactly the thing the import's four steps exist to prevent.

So the core needs a way to accept a list from a plugin and put it in front of
the board, with the core's own preview, decisions, apply and audit.

Facts about the core this decision builds on:

- An upload is held as an `ImportSession` row. The rows of the file are stored
  encrypted as one value (ADR 0002). The bytes of the file are not stored: they
  are parsed in the request and dropped.
- A session lives 24 hours (`SESSION_LIFETIME_MS`), and a nightly job deletes
  expired sessions that are not running.
- The preview is planned by a background job, records the import revision it
  read (`previewedRevision`), and stops when nobody watches it. The apply
  refuses to start when another import has written since the preview.
- An applied session keeps its encrypted rows until it expires. Nothing reads
  them again after the apply.
- Every import route needs `addressBook:read` and `addressBook:write`.
- Plugin settings are stored as plain JSON and returned to the browser
  (`apps/api/src/plugins/plugin-admin.service.ts`, `readSettings`).
- Every route a plugin contributes needs a signed-in person, and `@Public()` on
  it has no effect (ADR 0003). The device routes of draft ADR 0031 (#404) answer
  only `GET` and `HEAD`, and only for a plugin that reads nothing from the
  register.

## Decision

### Words

An **import proposal** (importförslag) is a member list a plugin has handed to
the core for the board to review. It is an import session that a plugin opened
rather than a person. The term goes into GLOSSARY.md with the change that
implements it.

### A permission that proposes and reads nothing

The manifest gains the permission `addressBook:proposeImport`. The consent
screen states it as: "Can put a member list in front of the board for review.
Nothing is written to the register until a board member confirms it on the
import screen."

It grants `host.imports` (below) and nothing else. It grants no read of the
register, and it does not raise the capability floor of the plugin's routes
(`routeCapabilityFloor`): a plugin with this permission alone can show nobody
anything from the register, because it holds nothing from it.

A plugin that declares it must also declare the personal data categories
`personalIdentityNumber` and `protected` (see "What the plugin handles").

### The plugin hands over a file

```ts
export interface PluginImports {
  /**
   * Hands a member list to the core for the board to review. Resolves once the
   * core has parsed the file and stored the proposal, or rejects with
   * ImportProposalRefusedError and stores nothing.
   */
  propose(file: {
    fileName: string;
    content: Uint8Array;
  }): Promise<ImportProposalReceipt>;

  /** Where one of this plugin's own proposals stands. */
  status(proposalId: string): Promise<ImportProposalStatus>;

  /** Withdraws this plugin's pending proposal. True when there was one. */
  withdraw(proposalId: string): Promise<boolean>;
}

export interface ImportProposalReceipt {
  proposalId: string;
  /** Data rows read from the file, below its column titles. */
  rowCount: number;
  expiresAt: string;
}

export interface ImportProposalStatus {
  state:
    | "pending"
    | "applying"
    | "applied"
    | "failed"
    | "rejected"
    | "superseded"
    | "expired"
    | "withdrawn"
    | "unknown";
  /** When it reached the state it is in. Null while pending or unknown. */
  decidedAt: string | null;
}
```

The plugin hands over **the file**, CSV or XLSX, and the core parses it with the
same parser, the same limits and the same reason codes as a file a board member
uploads. A list from a manager's system that arrives as JSON is written out as
CSV by the plugin first.

The alternative was a table of strings, already parsed. It was rejected because
the plugin would then parse spreadsheets itself, inside a bundle that may carry
no dependencies, and an XLSX file is a zip archive: the core has already been
hardened against what an archive can do, and two parsers would read one file
two ways. Writing CSV is a few lines; reading XLSX safely is not.

`propose` is refused, with nothing stored, for any reason an upload is refused
(`file-empty`, `file-too-large`, `too-many-rows` and the rest), and for one more:
`file-unchanged`, when the bytes are the same as those of the last file from
this plugin that the board applied or that is still pending.

The plugin learns why a file was refused. It learns nothing about what the file
would do.

### What the core does with it

1. **It opens an import session marked as proposed by the plugin.** The
   session records the plugin's id and the SHA-256 digest of the bytes. It
   holds the parsed rows encrypted, exactly as an upload does.
2. **It fills in the mapping it saved for this plugin**, when the file's column
   titles are the ones that mapping was saved for, title for title. When they
   differ, the proposal waits with no mapping and the import screen says the
   columns have changed. Nothing is guessed silently: the board maps the
   columns as it does for an upload. One plugin is one source, with one saved
   mapping.
3. **It replaces the plugin's pending proposal, if there is one.** A plugin has
   at most one pending proposal. The older one becomes `superseded` and its rows
   are deleted. A board member previewing it at that moment finds the apply
   refused with `proposal-superseded`, and the screen offers the newer one.
4. **It does not plan the preview.** The preview is planned when a board member
   opens the proposal, for three reasons. A preview is taken against the
   register as it is, and the apply refuses one that another import has
   overtaken, so a preview planned days before anybody looks at it would
   usually be refused. Planning costs an Argon2id hash per row (ADR 0002),
   which is wasted on a proposal that is superseded unread. And a finished
   preview names the register's own persons beside the file's, which is more
   to hold encrypted for days than the rows alone.
5. **It puts the proposal in front of the board.** It waits in the board's
   "To handle" queue on the overview, for everybody holding `addressBook:read`
   and `addressBook:write`, and at the top of the import screen as "Proposed by
   <the plugin's name>", with the file name, the row count and when it arrived.
6. **It expires after 14 days.** A board is volunteers, and a proposal should
   survive a week away with room to spare. The nightly purge marks it `expired`
   and deletes its rows.

A proposal waits while another import runs. Only one import is applied at a
time, as today, and the board applies the proposal once the other has finished.

### Applying is a board member's act

Opening the proposal starts the import at the mapping step. From there it is the
import a board member runs today: the same capabilities, the same preview, the
same decisions for rows that match more than one person, the same token tying
the apply to the preview that was looked at. Nothing about a proposal can be
applied without that.

The board may also **reject** a proposal. It then becomes `rejected` and its
rows are deleted.

What is recorded:

- `IMPORT_PROPOSED`, on the `PLUGIN` channel, with no person, naming the plugin
  and the session, with the row count. Never the file name, which can carry a
  person's name: the audit log is never purged.
- `IMPORT_PROPOSAL_REJECTED`, on the channel of the person who rejected it.
- The apply, recorded as it is today: the confirming board member's, on their
  channel. The session names the plugin that proposed it, so the import screen
  and the run history show where the list came from.

Superseding, expiring and withdrawing are not audit entries of their own. A
proposal is superseded by the next one, whose `IMPORT_PROPOSED` is recorded; it
expires by the clock; and withdrawing deletes rows the register never received.
Each leaves its state on the proposal's record.

This is deliberately close to what the pending changes of draft ADR 0039 (#411)
ask: the proposer and the confirmer are recorded separately, the capability is
checked when the board member confirms, and a proposal expires. It is not one
of them. A pending change holds one action's input and dispatches it through
the action registry once confirmed. An import proposal holds a file that is
planned against the register only when somebody reviews it, and its apply is
the import's own chunked job, not an action.

### What the plugin receives

From the core, a plugin with this permission receives:

- the receipt: the proposal's id, the number of data rows the core read, and
  when it expires;
- a refusal's reason code;
- the state of its own proposals, and when each reached it.

It never receives what a row would do, which person a row matched, how many rows
matched, would be created or would change, the preview, the board's decisions,
or who decided. Each of those is a read of the register. A count of matched
rows looks harmless until the file has one row: then it says whether one named
person lives here, and that person may have protected personal data
(skyddade personuppgifter). This permission grants no read, so it returns none.

`status` answers `unknown` for an id that is not one of this plugin's proposals,
whether or not it exists.

A decided proposal stays answerable for 90 days after it was decided, then its
remaining record is deleted (below) and `status` answers `unknown`.

### What the plugin handles

The file is the association's member list. It can hold every name, address,
email address, phone number and personal identity number in the cooperative,
and rows about persons with protected personal data: the file does not say which
rows those are. The plugin carries it without reading it for anything, but it
carries it, so the board is told so on the consent screen. A manifest that
declares `addressBook:proposeImport` must declare the categories `name`,
`apartment`, `residency`, `email`, `phone`, `personalIdentityNumber` and
`protected`. Those last two are otherwise not for a plugin to declare, because
no other plugin can reach either.

Nothing comes back the other way. Once the file is in the core, its rows are
handled by the rules that already apply to an upload, unchanged: a proposal
gives a row no treatment an uploaded file would not get.

### Destruction

"The file is deleted" has to be true and checkable, so here is what exists, and
for how long.

| What                                      | Where              | Until                                                                                                                                         |
| ----------------------------------------- | ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| The bytes of the file                     | The plugin         | `propose` resolves or rejects. The plugin then drops its copy.                                                                                |
| The bytes of the file                     | The core           | Never stored. Parsed in the call and dropped, as an upload is today.                                                                          |
| The parsed rows, encrypted                | The import session | The proposal reaches any state but `pending` or `applying`: applied, failed, rejected, superseded, expired, withdrawn. Then they are deleted. |
| The preview, the decisions, the targets   | The import session | Deleted with the rows.                                                                                                                        |
| The proposal's record, without its rows   | The import session | 90 days after it was decided: the plugin, the file name, the digest, the row count, when it arrived, its state, when it was decided.          |
| `IMPORT_PROPOSED` and the apply's entries | The audit log      | The audit log's own rules. They carry no row of the file.                                                                                     |

Three rules follow for the plugin, and the catalog review checks them:

- the file, or any part of it, is never passed to `host.jobs`. A job's data is
  stored in the database until the job is done, so a file put in a job
  is a file stored;
- it is never written to the log, to the settings, to any store the host offers
  the plugin, or to an error the plugin throws;
- the plugin keeps no copy after `propose` returns, whether it succeeded or not.

What this does not reach: a database backup taken while the proposal was
pending holds its rows, encrypted under the instance's key, until that backup is
deleted. When that is depends on the backup schedule the operator keeps
([backup and restore](../backup-and-restore.md)), not on the core. The same is
true of every encrypted column the instance holds.

The deletion of the rows on a terminal state applies to every import session,
not only to a proposal. Today an applied upload keeps its rows until its 24
hours run out, and nothing reads them.

### The plugin's own history

A plugin that wants to show the board what it received does not keep its own
record of it. The proposals are the history: the core lists a plugin's
proposals, with their states, on the import screen. A plugin that kept, for
example, the sender address of each email would be keeping personal data, which
draft ADR 0033 (#404) does not allow in its store, and would need the records
of draft ADR 0037 (#413) to keep at all.

### What the core does not add

**No inbound route for a machine.** A relay cannot post a file to a plugin
route, because every plugin route needs a signed-in person, and a device route
reads only. A plugin that gets files from outside fetches them: a scheduled job
(`jobs:schedule`) asks its relay for what is waiting, proposes each file, and
acknowledges it to the relay only once `propose` has resolved or been refused.
The relay keeps what was not acknowledged until its own time limit. This works
on an instance behind a home router, which a post from outside does not. An
inbound route for machines is a separate decision, with its own credential and
its own consent text, and nothing here needs it.

**No reply to the board.** The core does not mail the board about a proposal.
It waits in the board's queue. A plugin that wants to answer the person who sent
the file does so itself, with `mail:send`, to the address the file came from.

### Two things the plugin needs that the core does not have yet

- **A secret setting.** The plugin authenticates to its relay with a credential,
  and a `text` setting stores it in plain JSON and returns it to the browser.
  The `secret` field type that draft ADR 0037 (#411) asks for answers this: kept
  out of the browser, the audit log and the exports, and returned in clear only
  by `host.settings.read()` on the server. A plugin that fetches from a relay
  does not ship before it exists.
- **A declared outbound host.** The relay is where the plugin connects to, and
  draft ADR 0037 (#411) asks for the manifest to say so. The relay is a
  processor for the association: it receives the member list on the
  association's behalf.

### Contract version

`host.imports` is added after contract version 1 shipped, so a plugin
feature-detects it, as it does `host.actions`.

## Consequences

- The core gains the import proposal: two columns on `ImportSession` (the
  proposing plugin and the file's digest), the new states, `host.imports` and its
  refusal codes, the permission and its consent text in Swedish and English,
  "Proposed by" on the import screen, a queue entry on the overview, the
  `IMPORT_PROPOSED` and `IMPORT_PROPOSAL_REJECTED` audit actions, superseding,
  the 14-day expiry, the 90-day record, and a contract test that a plugin with
  the permission can neither read nor apply.
- Every import session drops its rows as soon as it reaches a terminal state.
- The saved mapping per source and the skip of an unchanged file, which a board
  member's own re-import gets as well, are keyed so that a plugin is a source.
- Draft #415 makes `personalIdentityNumber` and `protected` invalid in a
  plugin's manifest. Whichever lands second makes the exception for
  `addressBook:proposeImport`.
- The install consent asks whether a plugin "sends personal data outside the
  instance". A plugin that receives the list from its publisher's relay is
  receiving it from a processor, and the question has to be read, and worded, as
  "sends or receives".
- `ImportSession.createdById` stays a named gap under ADR 0019. A proposal has
  no person in it: who rejected one is answered by `IMPORT_PROPOSAL_REJECTED`,
  and who applied one by the apply.
- A plugin can put a list in front of the board as often as it likes, but only
  one at a time, and an unchanged file is refused. The worst a misbehaving
  plugin can do is fill the board's queue with one stale item.

## Rejected alternatives

- **A plugin that writes the register.** The register cannot be corrected by
  editing, and no plugin should write it unseen.
- **An action through the registry.** `host.actions.invoke` needs a person on
  the request, and an import is not one action's input (above).
- **The plugin parses and hands over rows.** Two parsers for one file, and the
  harder one inside a bundle with no dependencies (above).
- **The preview planned when the file arrives.** Usually stale before anybody
  reads it, and it costs the work of planning for a file that may be replaced
  unread (above).
- **Counts of what the file would do, returned to the plugin.** A read of the
  register under a permission that grants none (above).
- **The relay posts the file to the instance.** Needs an inbound route for
  machines, which the core does not have, and an instance reachable from
  outside.

## Revisit triggers

- **A plugin needs more than one source**, for example both the mailed file and
  a manager's feed, each with its own mapping.
- **A source sends changes rather than the whole list.** An import reads a whole
  list; a feed of changes is a different flow.
- **A relay has to deliver as soon as the file arrives**, faster than a
  scheduled fetch: that is the inbound route above.

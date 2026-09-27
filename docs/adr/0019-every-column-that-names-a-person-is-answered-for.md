# ADR 0019: Every column that names a person is answered for by the access report

Date: 2026-09-27

## Status

Accepted

## Context

ADR 0018 tied every section of the data subject access report (registerutdrag,
GDPR art. 15) to the row of the record of processing activities that covers
it. That map runs from sections to rows. Nothing ran the other way, from the
tables that hold rows about a person to the sections that read them, and ADR
0018 itself named four tables the report did not read: `news_delivery`,
`meeting_notice_delivery`, `invitation` and `auth_session`, the last with the
IP address and the browser name of every sign-in.

The report's completeness rested on its own list of sections, which the header
of `apps/api/src/retention/data-subject-report.ts` calls the checklist a
reviewer reads. A table added without a section left that list complete-looking
and wrong.

The browser keeps its own copy of the report type in
`apps/web/src/register/register-api.ts`, because it may not import server
types. Nothing tied the two. The API's report carried the member charges, the
fee rates and the fee notices; the browser's type had no such keys, the printed
document no such sections, and both builds passed.

## Decision

### The schema is walked for every column that names a person

`apps/api/src/testing/person-columns.ts` states the rule: a column names a
person when it is called `personId`, `userId` or `emailIndex`, or ends in
`PersonId`, `ById` or `EmailIndex`, or is the key of a relation to `Person` or
`User`. The first half runs over the generated client's scalar field enums, one
per model; the second over the schema text, so a foreign key to either model is
found whatever it is called. On the schema at this change it finds 87 columns in
56 models.

A walk here where ADR 0018 chose a typed map there. Which sections the report
has is an interface the compiler enumerates. Which columns name a person is a
fact only the schema states, and a list kept by hand is the thing that was
missing.

### Every column is answered for, in a typed list

`apps/api/src/retention/data-subject-report-coverage.spec.ts` holds
`COLUMN_COVERAGE`, typed so that an entry for a model or a column that does not
exist fails to compile. Each column has one of:

- **the sections that read the rows it reaches**, including what is reached
  through them: the residency reaches the charges, fee rates and fee notices on
  the apartment, the member register entry the terminations and lien notes, the
  transfer its reversals and reporting obligations;
- **the audit actions it acted as**: the column names who acted for the
  association on a row about something or somebody else, and the act reaches
  that person's own report through the audit log, where the entries carry both
  the actor and the subject. The report names the act and not every row a board
  member touched. An entry holds only where the service that writes the column
  records the action with that column's person as the actor. The owner of an
  OAuth client is one: `POST /api/oauth-clients` is the only route that
  registers a client by hand, it sets `OauthClient.userId` to the
  administrator's account and records OAUTH_CLIENT_REGISTERED with them as
  actor, and a client that registers itself from its metadata document names no
  account. Three columns are written by more than one act - a thread is taken by
  hand or by answering it, a group's creator is added to it by creating it, and
  a processing's last editor is set by the act that records it - and list both;
- **a reason none does**, one of four: `credential` (the row is a secret that
  opens the account: the password hash, the TOTP secret and backup codes),
  `neverWritten` (no production file writes the model), `addressOnly` (keyed by
  an address, which identifies nobody) and `gap`.

The spec fails for a column the walk finds with no entry, for an entry the walk
does not find, for a `gap` not in the pinned list of four, and for a
`neverWritten` model whose delegate a production file writes - read from the
same walk of the source the erasure specs use, through `writtenDelegates` on
`SourceFacts` in `apps/api/src/testing/erasure-source-facts.ts`.

### Both applications are held to the report's keys

`DATA_SUBJECT_REPORT_SECTIONS` in `packages/shared` lists every key of the
report in its order. The API's `DataSubjectReport` and the browser's are each
asserted, at the type level, to have exactly those keys, and the map's keys are
asserted to be the tuple in order. The printed document's `SECTION_TITLE` is
typed over the tuple, less the stamp and the controller, and every section
heading reads it; a test holds the document to printing every title. The three
sections the document lacked are printed.

### Four sections, and passkeys on the account

- **`signInSessions`**: every session the account holds, ended ones included:
  when it began, when it was last renewed (renewal happens on use, at most once
  a day, so it bounds the last use to a day), when it ends, and the IP address
  and the browser name verbatim as stored, an empty string read as not recorded.
  Never the token. It maps to `addressBookAndAccounts` as `notProvided`, beside
  `account`: when somebody signed in and from where is the association's record
  of access, on the reading the export already applies to
  `connectedApps.lastUsedAt`.
- **`invitations`**: when each was sent, until when it was valid and when it was
  accepted. Never the token hash, and not who sent it, which is the board
  member's act and on their report through the audit log. It maps to
  `signupRequestsAndInvitations`, legitimate interest.
- **`newsDeliveries`** and **`meetingNoticeDeliveries`**: every copy of a news
  mailing, an SMS mailing or a notice of a general meeting addressed to the
  person, whether it went out and, where it did not, why - as the closed code
  the workers write, which the document puts into words. A stored code outside
  the set reads as not recorded. Neither states an erasure date, because no
  purge reaches either ledger. They map to `newsMailings`, legitimate interest,
  and `meetingRecords`, legal obligation.
- **`account.passkeys`**: each passkey's name, when it was added and whether it
  is synced between devices. Not the public key, the credential id, the counter
  or the transports.

None of the four is carried by the portability export, and no existing field
changes name or shape.

### What makes their statements true

A signed-in session ends thirty days after its last renewal and the sign-in
library deletes one only when it is signed out of or presented after it ended.
`sweepExpiredSignInSessions` deletes every ended session on the service-data
purge's minute, except those of a person under a standing legal hold or
restriction: a session is a record of access and not only a credential, and a
hold and a restriction stop every purge for the person they stand for.

The purge deletes every invitation of the person, accepted or not, and selects a
person who still has any. An accepted invitation is a spent record of an
activation the log holds as INVITATION_ACCEPTED, and kept past the account it
would serve no purpose (art. 5(1)(e)).

The record of processing activities says both, names former residents on the
news mailing row and the meeting's record, names residents and people outside
the association on the meeting's record, where a proxy holder or an assistant
can be anybody, names everybody an invitation can reach on the sign-up and
invitation row, and says that a decided sign-up request is kept and no purge
reaches it.

## Consequences

The four tables are on the report, the charges, fee rates and fee notices are
on the printed document, and the export is unchanged.

Ended sessions are swept nightly. Persons purged before this change who still
have an accepted invitation are selected once more on the next run, and each
gets a SERVICE_DATA_PURGED entry for it.

Four columns are named gaps, each closed in a change of its own:

- `SignupRequest.emailIndex`: an approved request - the name, the phone, the
  claimed address and the apartment the person typed - is kept, and reachable
  from the person through the SIGNUP_REQUEST_APPROVED entry whose target it is.
  A section waits on a retention decision for decided requests.
- `ContactSubmission.handledByPersonId`: marking a message handled writes no
  audit entry, so the board member's act reaches no report.
- `ImportSession.createdById`: the upload of a member list is not audited
  either; the session is deleted when it expires.
- `MeetingAttendance.onBehalfOfPersonId`: printed on the assistant's report as
  an identifier, while the member they came with is not told on theirs.

The rule is the guard's limit. A column that names a person under another name
and without a relation passes it, and so does data keyed by a value rather than
a column: the sign-in library's verification rows, a one-time link or code in
transit keyed by the address, and an import's rows before the apply writes the
register.

The browser is tied to the report's keys and not to their fields. A field added
to a section is still its author's to print.

The IP address and the browser name are shown as held. Whether to record them
at all is open: nothing in Open BRF reads either, and stopping would change
what the sign-in library writes.

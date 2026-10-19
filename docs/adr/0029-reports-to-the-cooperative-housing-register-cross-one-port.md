# ADR 0029: Reports to the cooperative housing register cross one port

Date: 2026-10-19

## Status

Accepted

## Context

Lag (2026:484) om bostadsrättsregister, 3 kap., makes a housing cooperative
report each grant (upplåtelse), transfer (övergång) and termination
(upphörande) to Lantmäteriet within two weeks, and a registered överlåtelse that
has been hävd or gone back to the seller with no period at all. Lag (2026:485)
3 § adds a one-off initial supply of what the register is to hold, due
31 December 2027. 3 kap. 10 § lets Lantmäteriet order a late report in under
penalty of a fine, and a registration takes effect "vid den tidpunkt då en
fullständig anmälan kom in till Lantmäteriet" (3 kap. 2 and 3 §§), so a missed
or mistaken report can cost a third party their protection.

Everything up to the report itself is built:

- the obligation ledger (`register_report_obligation`), one dated duty per
  reportable event, written by the transaction that records the event, with the
  fourteen days stated in a CHECK;
- the queue a board reads (`RegisterReportService.queue`), and the notice to
  every seat when a window opens;
- the board's statement that an anmälan reached Lantmäteriet, an audit entry
  (`REGISTER_REPORT_MADE`) rather than a register row, because the ledger is
  append-only;
- the initial supply as a documented file and a printable extract
  (`docs/register-supply-contract.md`).

What is missing is the transmission, and it cannot be built against
Lantmäteriet yet. Förordning (2026:898) 2 kap. 2 § allows an anmälan to be
transferred electronically "enligt föreskrifter som Lantmäteriet får meddela",
and 5 kap. 1 and 2 §§ leave the form of the anmälan to the same föreskrifter.
None has been issued. The register is still being built (Lag (2026:485) 2 §
and 10 §). There is no endpoint, no wire format, no way to authenticate and no
receipt to test against.

The obvious way to make progress is a stub that stands in for Lantmäteriet. A
stub has one failure that matters here: if it is ever reachable on an instance
an association runs, it answers "received" for a report that went nowhere. The
duty then reads as discharged, the queue stops showing it, the deadline passes
with nobody looking, and the first anybody hears of it is Lantmäteriet's
föreläggande. That is worse than having no transmission, because the manual
statement at least records something a board member did.

## Decision

### One port, and which side of it each part is on

`RegisterTransmission` (`apps/api/src/registers/register-transmission.ts`) is
the only seam between what the association owes and how it reaches
Lantmäteriet. It has one method, `submit(report)`, and one flag, `available`.

On the platform's side of the port, built and tested now:

- **what a report says**: `RegisterReport`, rendered from one ledger row and the
  register rows it points at, and validated by `registerReportSchema`
  (`register-report-content.ts`) before it is handed over;
- **who may send one**: the capabilities below;
- **what is recorded**: the entries below, and the duty's state on the queue.

On Lantmäteriet's side, which an adapter implements when the föreskrifter
exist: the wire format the report is mapped to, the endpoint, how the
association or its representative authenticates, and how Lantmäteriet's answer
is read back into one of the outcomes below.

The schema is Open BRF's own, for the reason the initial supply's file is: the
content is the statute's, the shape is not anybody's yet. An adapter maps from
it. It does not change it to suit one interface; a field the föreskrifter turn
out to require that the schema lacks is a change to this ADR and to the schema
together.

### A report carries what the register needs and nothing more

Every report names the association by name and organisationsnummer, the
apartment by its Lantmäteriet number and address, and the platform's own
reference: the obligation id, which an adapter sends as the request's
idempotency key where the interface has one. Then, by kind:

| Kind                                          | Event fields                                                                                                  | Person                                                              |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| Grant (3 kap. 2 §)                            | the day of the upplåtelse                                                                                     | the holder                                                          |
| Transfer (3 kap. 3 §)                         | the day of the övergång, which case of the section it is, the membership decision date where the case has one | the acquirer, or the association where the bostadsrätt passed to it |
| Termination (3 kap. 4 §)                      | the day it took effect, the ground                                                                            | none                                                                |
| Transfer reversal (3 kap. 3 § tredje stycket) | the day of the reversal, the ground, the day of the övergång it undid                                         | none                                                                |

A person is named, given their personal identity number in its twelve-digit
form, and given their postal address unless they have skyddade
personuppgifter, in which case the address is withheld and the report says so,
on the initial supply's reasoning. The seller of a transfer is not carried: the
register already holds them as the holder the transfer ends. Neither is the
price, nor anything the ledger row does not point at.

The report is refused before anything is recorded or sent where it could not be
complete: no association or no organisation number, a holder with no personal
identity number or one that cannot be read, or a transfer whose case cannot be
stated. An anmälan that is not fullständig does not take effect, so sending one
would only move the failure somewhere the board cannot see it. A transfer whose
membership decision was recorded before the board was asked which case applied
is reported as the first case: its duty was entered on that case's day, and the
register refuses to state a case for it afterwards.

### Three outcomes, and what each records

The port answers `received`, with Lantmäteriet's own day and reference, or
`rejected`, with Lantmäteriet's reason codes. Anything else is thrown, and
means the outcome is unknown.

- **Received** writes `REGISTER_REPORT_MADE`, the entry the queue already reads,
  with the day Lantmäteriet gave and its reference. The day is Lantmäteriet's
  and not the platform's: it is the day the statute makes operative, and the
  only one that can be checked against the register afterwards. The duty moves
  to reported on the queue with nothing else changed.
- **Rejected** writes `REGISTER_REPORT_REJECTED` with the reason codes. The duty
  stays owed and its deadline keeps running; a rejection discharges nothing.
- **Unknown**, which is a throw, an answer that does not parse, or no answer
  within sixty seconds, writes nothing further, logs the failure by its class
  name only,
  and answers 502 with a reason telling the board to check with Lantmäteriet
  before sending again. A resend is not refused: the obligation id lets an
  adapter make it idempotent, and refusing would leave a duty the platform can
  no longer help discharge.

### The disclosure is recorded before it is made

`REGISTER_REPORT_TRANSMITTED` and `PROTECTED_DATA_REVEALED` are written and
committed before the report is handed to the port, naming every person whose
personal identity number it carries. A crash, a timeout or a lost connection
after the bytes leave therefore cannot leave a disclosure unrecorded. A report
names one person at most, and that person is the entries' target as well as in
their context, which is what puts the disclosure on their own access report.
The cost
is an entry for an attempt that may never have reached anybody, which is the
side to err on: the data subject access report shows the person a disclosure
that was attempted, never misses one that happened.

### One transmission per duty at a time

The send runs inside a transaction holding a transaction-scoped advisory lock on
`register-transmission:<obligation id>`, taken with `pg_try_advisory_xact_lock`.
A second board member pressing send while the first is waiting for Lantmäteriet
is refused with `transmission-in-progress` rather than queued, because a queued
second send would go out the moment the first came back received. The entries
above are written outside that transaction, so a rollback of the lock-holder
cannot take them with it. A manual statement made during a send is not
serialised against it; two statements about one duty are already two true
entries, and the queue reads the earliest.

### The stub is a test fixture and nothing else

The module binds `UnavailableRegisterTransmission`, whose `available` is false.
The service refuses with `transmission-not-available` before it reads a row,
decrypts a number or writes an entry. Until an adapter exists, the manual
statement is the way a duty is discharged, exactly as before.

The stub, `RecordingRegisterTransmission`, lives in `apps/api/src/testing/`,
which the production build excludes, and is bound only by a test calling
`overrideProvider`. It validates what it is given against
`registerReportSchema`, records it, and answers with whatever outcome the test
scripted, including a throw and a delay. No environment variable, setting or
flag selects it. `register-report.controller.spec.ts` asserts the module's
binding, so a change that bound the stub, or anything else, in production fails
the build rather than a deadline.

### Capabilities

The route, `POST /api/register-reports/transmissions`, requires
`apartmentRegister:read`, `protectedData:reveal`, `registerReport:export` and
`addressBook:write`. The first three are the initial supply's, for the same
reasons: the content is the apartment register's, it decrypts personal identity
numbers the product otherwise masks, and it supplies the register onward to an
authority. The fourth is what recording a report made already requires, because
a received answer discharges a statutory duty.

### What is not decided here

- **Where an adapter lives.** The ROADMAP's line puts a module that needs
  Apteo's own contracts or infrastructure in the paid list, and one that needs
  only the association's own credentials in the core. Which the föreskrifter
  call for is not known.
- **The initial supply over the port.** It stays a file the board checks and
  signs. It is one act per association with its own deadline and its own
  föreskrifter, and the port gains a second method when those are issued.
- **The board's screen.** The queue gets a send button with the first adapter.
  With only the unavailable binding there is nothing for one to do.

## Consequences

- Everything a report depends on except the wire is exercised now, in
  `register-transmission.int-spec.ts`, against a real database: the rendering,
  the refusals, the four entries, the lock, and each outcome's effect on the
  queue.
- An adapter is a class implementing one method and a mapping from one schema.
  It does not touch the ledger, the queue, the audit log or the capabilities.
- An adapter must never answer `received` without a receipt from Lantmäteriet,
  and must not log or quote the report in an error: the service logs a thrown
  error by class name only, and an adapter's own log lines are its
  responsibility.
- Two new audit actions. `REGISTER_REPORT_TRANSMITTED` reaches the access
  report of the person the report named and of the board member who sent it;
  `REGISTER_REPORT_REJECTED` names nobody and reaches the sender's.
- The route answers `transmission-not-available` on every instance until an
  adapter is bound. That is the intended behaviour, not a fault.

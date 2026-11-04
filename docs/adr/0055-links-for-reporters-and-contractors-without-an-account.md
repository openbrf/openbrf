# ADR 0055: Links for reporters and contractors without an account

Date: 2026-11-02

## Status

Accepted, with the questions under [Open questions](#open-questions) left to the
owner, and with the contractor's link behind the legal review the issue module
plan names (decision 25). The second of four records for the issue module (ADRs
0054 to 0057), citing that plan's decisions by number as
[ADR 0054](0054-issue-types-statuses-and-outcomes.md) does. Replaces the rule
the comment over `IssueReportController` states, that the issues module has no
`@Public()` route (see [What replaces the rule](#what-replaces-the-rule)).

## Context

Two people take part in an issue without an account in Open BRF:

- **A reporter who wrote through the website's form** and gave an email address.
  If they gave one, they get mail with a private link to a simple page for their
  case, where they read the conversation and reply. Without an address there is
  no follow-up. Text only, no upload (decision 20).
- **A contractor** given a work order. A link per work order shows them that
  work order and the photographs the board chose, never the report or the
  reporter. They accept or decline, add a note and photographs, and mark it done.
  The link is revocable, and ends when the work order is done or after 30 days
  (decision 24).

The issues module has no route that answers without a session. The comment over
`IssueReportController` says why: "the website's form is server-rendered by the
site layer, which calls the services directly, so the application exposes no
unauthenticated write surface for issues at all." The schema says the same of
`IssuePhoto`: "the public form takes text and never files, so the platform
exposes no unauthenticated upload surface at all." The contractor's photographs
make the first upload in the product that no account stands behind.

A file on `IssuePhoto` is readable by the reporter, because that join is what
`MediaService` reads to let a reporter see their own photograph. A photograph a
handler or a contractor adds therefore cannot go on that join.

## Threat model

What the two links have to withstand, in the order the plan lists them:

- **Guessing a link.** Somebody without one tries values until one opens a case.
- **A link that leaks.** A mail forwarded, a phone left unlocked, a link pasted
  into a chat, a browser history, a proxy's log. Whoever holds the link is the
  reporter or the contractor as far as the instance can tell.
- **A link that outlives its purpose.** A contractor whose job is done, or who
  was replaced, still holding a way in.
- **Learning that something exists.** An answer that differs between an unknown
  link, an expired one and a revoked one tells a caller which links were real.
- **Volume.** A script filling the case with replies, or the disk with uploads.
- **Hostile files.** A file named as an image that a browser would run, and the
  location and device a photograph's metadata gives away.
- **Reaching past the work order.** A contractor reading the report, the
  reporter, another work order or another case.
- **Reaching a ring-fenced case.** A complaint about a neighbour reaching
  somebody outside the board through a work order, which decision 32 forbids
  whoever writes it.

## Decision

### What replaces the rule

The rule becomes: **no route in the issues module's application controllers is
`@Public()`, and the two links are the only way to an issue without a session.**
Each is its own controller in the site layer, beside the website's forms, which
already answers without a session, sets no cookie and is rate limited. Each of
its routes is `@Public()` and carries `@PublicRateLimit`, resolves the token
before it reads anything else, and calls the issues module's services with the
token's grant and nothing more: the reporter's link reaches one case, the
contractor's one work order. The services take that grant as an argument of its
own, never a principal, so no path through them confuses a link with an account.

The pages are server-rendered, as the website's are: plain forms, no
application bundle, no cookie and no third-party request.

### The token

- **32 random bytes** from the operating system's generator, in base64url behind
  a prefix naming its kind, one for each link, as a device token has
  (`device-token.ts`). The prefix is for secret scanners and for a person reading
  where a link was pasted; nothing grants on it.
- **Stored as its SHA-256 digest**, as an invitation's token is (`hashToken`),
  with a unique index, and looked up by that digest. The token itself is in the
  mail or on the screen that issued it and nowhere else: not in the database, an
  audit entry, a log line or a job's payload.
- **One kind per link.** A reporter's token opens no work order and a
  contractor's no case page, and each is looked up only by its own controller.
- **Never a case's identifier or number** in the address or on the page as a key:
  the token is the whole address. A case number is shown as a label, and nothing
  on either surface accepts one.
- The pages are served with `Referrer-Policy: no-referrer`,
  `Cache-Control: no-store` and `X-Robots-Tag: noindex`, so the token leaves in
  no `Referer`, stays in no shared cache and is listed by no search engine. No
  log line records the path of these routes. The headers are set by a hook on
  the route the router matched, or on the decoded path where no route did, so a
  percent-encoded spelling of the path carries them as well and the refusals the
  rate limit and the exception filters build carry them too, and none of these answers carries an `ETag`, a CORS header or a
  cookie. Under `no-referrer` a browser posts the page's own form with
  `Origin: null`, so a post is accepted with that origin or the instance's own
  and refused with any other: the token, not the origin, is what stops a forged
  post, because there is no cookie for one to ride on.

### Expiry and revocation

A contractor's link ends at the first of: the work order marked done, 30 days
after it was issued, and a handler revoking it (decision 24). Issuing a new link
for the same work order revokes the old one, so a work order has one live link
at most.

A reporter's link is issued with the first mail to the reporter's address, the
one that follows their report, and ends at the first of: 30 days after the issue
is closed, 365 days after the issue's latest message (or the day the link was
issued, if no message came), a handler revoking it, and the purge clearing the
issue's contact details ([ADR 0057](0057-purging-issues-in-two-layers.md)),
which also removes the link. In the 30 days after closing the page reads and takes no reply, until
the reopening rule decides what such a reply does (ADR 0054). Both numbers are
constants in code. This answers question 1 as the threat review of this record
required (APT-9360, control B4): "until the contact details are purged" can be
years, and a link is a bearer secret in a mailbox. A handler can revoke it, and
doing so mails nobody. A revoked link is not issued again.

Every check is made on every request, at the moment of the request, by one
lookup that reads the token's digest together with its expiry, its revocation
and the state of what it opens. Nothing is cached, so a revocation bites on the
next request.

### No enumeration

Every refusal on either surface is the same page with the same status, `404`,
whether the token was never issued, has expired, was revoked, opens a work order
now done, or belongs to the other kind: a caller learns nothing from which it
was. The page says only that the link does not open anything, and how to reach
the association by its own means.

### Rate limits

Every route on both surfaces, its `GET` included, has a per-address budget
through `@PublicRateLimit`. The decorator's own comment says a `GET` is not
worth limiting, because the interface makes many; here it is the route a guess
is made on, so it gets a budget set for the most a real reader needs. Writes are
bounded per link as well: a reporter's replies and a contractor's notes per
hour, on the pattern of the feed's write budget, so a leaked link cannot fill a
case.

For the reporter's link the numbers are: 30 page reads and 5 messages a minute
per client address, spent before the token is resolved so that a refusal is
the same for every token; and 10 messages an hour and 100 in all per link,
counted in the database against the issue the link opens, so a link used from
many addresses shares one budget. A message is text of at most the length of
any issue message, and a body larger than such a message can be sent as is
refused before it is read.

There is no lockout of a token after failed attempts. A wrong token has no row
to lock, and locking a live link after strangers' failures would let a stranger
end it. The defence against guessing is the address budget and 256 bits.

The website's form cannot be made to mail a stranger at will: one link mail
per issue, never sent again, at most three a day to one address, counted in the
database, and none to an address whose owner restricted processing (GDPR art.
18). The form answers the same whether a mail goes or not, because the mail is
sent by a job after the answer. There is no way to ask for a link to be sent
again. "Never sent again" has one exception: if the mail server takes the
message and the stamp that records it then fails, the job's retry mints a new
token and mails that, and the first mail's link opens nothing. Only the digest
is kept, so the first token cannot be sent again.

A link that was issued and will not be mailed (a restriction granted, the issue
closed, no mail settings, or the retries spent) is deleted, so it no longer
counts toward its address's three a day. A link whose mail is still being
retried keeps its place in the count.

### The contractor's photographs

The first anonymous upload, and bounded accordingly:

- **Only while the link is live**, and only images. `MediaService.upload`
  identifies the type from the bytes and never from the name or the declared
  type, and strips EXIF, XMP, IPTC and comments before anything is stored. A
  file it cannot identify as an image is refused, and nothing is stored for it.
- **A cap per work order** on the number of files and on their total size,
  beside the per-file cap of `OPENBRF_MAX_UPLOAD_BYTES`. An issue takes six
  photographs today, and `IssueService` says of that cap that it is no defence
  against filling the volume, because nothing caps how many reports an account
  may file. A cap per work order is one: only a handler creates a work order,
  and its link ends within 30 days.
- **On a join of their own**, never `IssuePhoto`, stored as `INTERNAL` under
  `issues:handle` and readable by the handlers the case lets in. The reporter
  never reads them, and nothing a contractor uploads reaches the reporter's
  page.
- **Uploaded and removed with `recordFileName: false`.** `MediaService.upload`
  and `remove` write the supplied file name to the audit log unless told not to,
  and a contractor chooses that name, so it can carry a person's name or
  address that the log, which the purge cannot reach, would keep after the
  photograph is gone. The log records the file's identifier and the work order,
  never its name, as the binder and the board's mailbox already do.
- A handler can remove any of them, and removing one removes the file from
  storage.

The generic media route needs a case-level check for both joins. For an
`INTERNAL` file, `MediaService.open` asks only that the viewer hold the
file's capability (or, for an `IssuePhoto`, be its reporter), and never whether
the case lets the viewer in. A property manager who kept the address of a file
could therefore still read it after the case became board-only, whether a
reporter's photograph or a contractor's. The change that builds this adds the
case's own access rule to `MediaService.open` for a file on `IssuePhoto` or on
the contractor's join, beside the capability and not instead of it: a viewer the
case does not let in is told the file is not found, exactly as for the case. A
test fails when that check is removed.

What the contractor sees of the board's photographs is the set the board chose
for the work order, served through the contractor's controller by the token's
grant, and nothing else of the case.

### What each link shows

The **reporter's page** shows the case number, its type, where it stands, the
conversation the reporter is part of, and a field to reply. Replies are signed
by a role, the board or the property manager, never by a person (decision 19).
It never shows the assignee, an internal note, a work order or a contractor. A
reply is text only.

The **contractor's page** shows the work order as the handler wrote it and
previewed it, the photographs chosen for it, and the contractor's own answers.
It never shows the report, the reporter, the conversation or another work order.
A ring-fenced case has no work order, so it has no contractor's page either
(below).

### A ring-fenced case never reaches a contractor

Decision 32 keeps Störningar to the board: "never to a property manager,
contractor, notice, AI or MCP". Handling by the board only
([ADR 0054](0054-issue-types-statuses-and-outcomes.md)) does not deliver the
contractor part of it. That rule decides which people with a session may read a
case, and a contractor has no session: a work order is the board's own act,
and a board member is let into a ring-fenced case. So the rule is stated on its
own: **nothing about a ring-fenced case reaches a contractor**, by any of the
three ways this record opens to one.

- **No work order.** Writing a work order on a ring-fenced case is refused, and
  so is previewing, sending or reissuing one. The contractor register is not
  offered on such a case at all.
- **No link.** A contractor's token is never issued for a work order on a
  ring-fenced case. The lookup that resolves a token reads whether its case is
  ring-fenced together with its expiry and its revocation, on every request, so
  a case moved into a ring-fenced type after a work order was issued stops
  answering its link from the next request, with the same `404` as every other
  refusal.
- **No mailed work order.** The fallback of decision 25 is refused on a
  ring-fenced case as the link is; the switch decides how a work order travels,
  never whether a ring-fenced one may.

Each refusal is made inside the issues module's service, where "the board only"
is answered for every read and write
([ADR 0054](0054-issue-types-statuses-and-outcomes.md)), and never by the screen
alone, so a later route or action cannot step past it. The MCP and AI surfaces
offer none of the three for any case
([ADR 0056](0056-issue-handling-on-mcp-and-ai.md)); this is the rule for the
board's own screen and for the token routes. It holds whatever marks a case as
ring-fenced, which is open (ADR 0054, question 5).

### Audit

Issuing a link, revoking it, and each answer a contractor gives (accepted,
declined, done) are recorded in the audit log, against the case and the work
order, with no free text and never the token. An act by a link holder has no
person behind it, so it gets an audit channel of its own: GLOSSARY.md says a
channel is "never inferred afterwards from a missing actor", and recording these
as the web interface would claim a session that did not exist.

### The legal gate

The contractor's link is built behind a switch that is off until the legal
review the plan names clears it (decision 25). Until then a work order is mailed,
with the preview and the stored recipient, date and contents, and the link is
switched on afterwards. Neither way is open on a ring-fenced case (above). The
reporter's link is not behind that gate.

## Open questions

Calls the plan does not make, left to the owner and listed on the task that
wrote this record:

1. **How long a reporter's link stays usable.** Answered by the threat review's
   control B4 and built that way (see [Expiry and revocation](#expiry-and-revocation)):
   30 days after closing, and 365 days after the latest message while the issue
   stays open. The owner may set other numbers; each is one constant.
2. **How a contractor's link reaches the contractor.** The register the plan
   describes holds a name, a trade and a telephone number (decision 23), so it
   has no address to mail the link or the work order to.
3. **A mailed work order and decision 21.** Decision 21 puts no free text in any
   mail. A work order mailed under the fallback of decision 25 is the handler's
   own text; whether decision 21 reaches it.
4. **A work order on an apartment whose household has protected personal data.**
   The contractor needs to know where to go. What the work order may say, and
   whether such a work order is refused, as the plan's research proposes.
5. **Whether a contractor may send anything but a photograph**, such as a PDF
   report. This record allows images alone, as the plan says photographs.

## Consequences

- The issues module keeps no `@Public()` route in its application controllers,
  and the comment over `IssueReportController` names the two site-layer
  controllers as the only ways in without a session.
- `@PublicRateLimit`'s comment gains the token reads as the exception to its rule
  on `GET`.
- The work order's service refuses every act on a ring-fenced case, and the
  contractor's token lookup refuses a work order on one, each with a test that
  fails when the refusal is removed.
- `MediaService` gains a read by a token's grant, which is audited against the
  work order, and a join other than `IssuePhoto` for photographs the reporter
  must not read.
- The audit channels gain one for a link holder, with its row in the data subject
  access report's "Via" column.
- The record of processing activities names a contractor as a recipient (art.
  30(1)(d)), which `recipientsFor` has no branch for today; whether a contractor
  is a third party or a processor is on the legal brief.

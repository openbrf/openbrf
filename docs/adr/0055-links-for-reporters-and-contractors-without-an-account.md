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
  the decoded path where it is a token's address, else the route the router
  matched, or the decoded path where no route did, so a percent-encoded
  spelling of the path (an escaped slash included) carries them as well and the
  refusals the rate limit and the exception filters build carry them too, and
  none of these answers carries an `ETag`, a CORS header or a cookie. Under
  `no-referrer` a browser posts the page's own form with `Origin: null`, so a
  post is accepted with that origin or the instance's own and refused with any
  other: the token, not the origin, is what stops a forged post, because there
  is no cookie for one to ride on.

### Expiry and revocation

A contractor's link ends at the first of: the contractor declining or marking
the work order done, 30 days after it was issued, and a handler revoking it
(decision 24; the other ends are listed under "When it ends" below). Issuing a
new link for the same work order revokes the old one, so a work order has one
live link at most.

A reporter's link is issued with the first mail to the reporter's address, the
one that follows their report, and ends at the first of: 30 days after the issue
is closed, 365 days after the issue's latest message (or the day the link was
issued, if no message came), a handler revoking it, and the purge clearing the
issue's contact details ([ADR 0057](0057-purging-issues-in-two-layers.md)),
which also removes the link. In the 30 days after closing the page reads, and a reply
through it reopens the issue as a signed-in reporter's does (ADR 0054): onto
its type's default in-progress status, alerting its assignee. A report merged
into another takes no reply. Both numbers are
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
per issue, never sent again, at most three a day to one address, no more in an
hour than the instance's ceiling (`OPENBRF_REPORTER_LINK_MAILS_PER_HOUR`, 30
unless the operator sets another), counted in the database, and none to an
address whose owner restricted processing (GDPR art. 18). The form answers the same whether a mail goes or not, because the mail is
sent by a job after the answer. There is no way to ask for a link to be sent
again. "Never sent again" has one exception: if the mail server takes the
message and the stamp that records it then fails, the job's retry mints a new
token and mails that, and the first mail's link opens nothing. Only the digest
is kept, so the first token cannot be sent again.

"One address" is the inbox the address reaches, not the address as typed: a tag
after `+` in the local part is dropped, and at Google (`gmail.com`, and
`googlemail.com` counted as it) so are the dots, which Google ignores.
Otherwise `someone+1@`, `someone+2@` and so on would each have three a day, and
a script typing a new tag each time could fill one inbox from the
association's mail account. The addresses are compared decrypted, under the
lock the count takes, rather than by an index of their own: the blind index of
the reporter's address stays the one matched against the register, and the
budget adds nothing for the purges to clear. An address among the day's
that cannot be read is skipped, not counted, so one damaged report does not
stop other reports' links. Two people whose addresses fold
to one form share three a day.

The hourly ceiling is for the instance as a whole, so a script typing many
different addresses cannot make the form a way to send mail either. Past it a
report is filed and its link is not mailed, as past an address's three a day,
and the form answers the same.

A link that was issued and will not be mailed (a restriction granted, the issue
closed, no mail settings, the address's three a day or the instance's hour
spent when a retry comes, or the retries spent) is deleted, so it no longer
counts toward either. A link whose mail is still being retried keeps its place
in the count.

Both count links issued, not mails sent. A link is issued in the transaction
that counts, under one lock that every delivery takes, and mailed after that
transaction commits. A count of mails would miss a link whose mail is on its
way, so two reports from one address delivered at once could each find a slot
free and a fourth mail go. Counted as issued, a link holds its slot from the
moment it exists. Since a link that will not be mailed gives its slot back,
the count holds the links that were mailed or are still being tried. The
budget belongs to the address, not to whoever typed it: three reports filed
with somebody else's address spend that address's day, and that is what keeps
the form from filling a stranger's inbox.

Whether the address is a restricted person's is asked of the people at that
address only: the reporter's address is indexed as a person's address and the
register is looked up by that index, so the check does not grow with the
number of restricted people. A person whose index predates the current
normalisation rules is read as well until the reindex rewrites it.

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
board's own screen and for the token routes. A case is ring-fenced when its type
is ([ADR 0054](0054-issue-types-statuses-and-outcomes.md#the-interim-answer-to-question-5)).

A closed issue is offered no work order until it is reopened. Previewing or
sending one on an issue in the `DONE` meaning is refused as `issue-closed`,
after the ring-fence is checked, and the work-order list says the issue is
`closed`, so the screen offers none. The text's retention clock runs from the
closing (ADR 0057), and reopening clears `closedAt`. This is a rule about when
a handler may write, not about what may reach a contractor, as the ring-fence
is: closing an issue does not recall a work order already written, and the
retention rationale below does not rely on it.

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

The review was done in November 2026. It found the contractor a recipient and a
controller of their own for a mailed work order, and left one question for
counsel: whether asking the contractor for notes and photographs through the
link makes them a processor for the association. The link stays off until that
is answered.

The switch is one setting of the instance, `OPENBRF_CONTRACTOR_LINKS_ENABLED`,
off by default. It is read in the lookup that resolves every contractor's
token, as a parameter of the same statement, so with it off every address
under `/arbetsorder`, a `GET` or a `POST`, answers the one `404` every dead
link gets, a link issued while it was on included, and the upload reads none
of its body. The one exception is a text post over the 64 KiB bound
(`LINK_TEXT_BODY_LIMIT`): the server refuses it with 413 before any handler
runs, as it does with the switch on and for any token, so it tells a caller
nothing about the switch or about a link. A handler cannot issue a link or
choose photographs for one while it is off; withdrawing a link stays possible,
because it only narrows. What came through a link before stays on the work
order's record either way. Turning the switch off refuses every link but does
not revoke them: a link that has not expired or ended opens again if the switch
is turned back on. So the work order's record still lists such a link as live
while the switch is off, saying that the switch holds it shut, and offers its
withdrawal and nothing else.

### The contractor's link as built

Built to the controls of this record's threat review (APT-9360, A to K), each
with a test that fails when the control is removed
(`site-work-order-link.int-spec.ts`). Where the review asked for something the
sections above leave open, this is what was decided:

- **Delivery (question 2).** The link is issued on a work order that was
  already written and mailed, and the handler's answer to issuing it is the
  one time its address is shown. The handler passes it on by the way they
  choose, a text message or their own mail, with a generic sentence the screen
  offers and nothing of the work order, the issue or the reporter (control
  K1). The instance mails no link: the token would then have to wait in a
  job's payload or be minted by the worker, and a mailed work order stays the
  one mail that carries a handler's text (decision 21). Issuing again revokes
  the link before in the same transaction, and a partial unique index holds a
  work order to one live link.
- **When it ends.** At the first of: 30 days after it was issued
  (`WORK_ORDER_LINK_DAYS`, never extended), a decline, done, a handler
  withdrawing it, the work order's text redacted or purged, its contractor
  removed from the list, its issue closed or ring-fenced, and a person with
  protected personal data having reported the issue, being recorded as a
  person it concerns ([ADR 0057](0057-purging-issues-in-two-layers.md#the-people-an-issue-concerns)),
  or living in its apartment, a residency recorded ahead of its move-in date
  included. Every
  one of them is read in the lookup on every request. A
  redaction, a purge, a ring-fence, a contractor removed and the issue closed
  (merged into another as a duplicate included) also revoke the link in their
  own transaction, so reopening the issue later brings no link back, and nor
  would a ring-fence changed behind the service (the service never lifts one
  from a type with issues, decision 32 of ADR 0054); the handler issues a new
  one if the work goes on. So does protection: marking a person as protected,
  and recording a protected person's residency (counted from the day it is
  recorded, not the day it begins), revoke the links of the issues they
  reported, of the issues recorded as concerning them and of the issues about
  that apartment, in the same transaction and audited on the channel of the
  write; so does recording a protected person as one an issue concerns. Issuing a link and those writes take
  one lock (`lockHouseholdProtection`), so a link issued while a protection is
  written is either found by it and revoked, or finds it and is refused. Every
  holder takes it after its other advisory locks and before it first writes a
  person or a residency, so none waits on another while holding what that one
  waits for; an import chunk with a residency holds it to the commit, and so
  holds link issuing, marking a person protected and a move-in back for as
  long as the chunk runs. Those three, and recording a person an issue
  concerns, run in a transaction allowed longer than an import chunk
  (`HOUSEHOLD_PROTECTION_TRANSACTION`), so they wait rather than fail.
  Clearing the protection restores nothing. A read still writes nothing. The
  handlers' record reads the same conditions, the protected household
  included, so it never says a link opens what the contractor is refused; the
  switch alone it does not read, as the switch section above says. A decline and done are final: no new link is issued
  for such a work order, and the handler writes a new one.
- **Question 4, for the link.** The mailed work order is not refused for a
  protected household (above), because nothing of the issue goes into it but
  what the handler writes. The link shows the board's photographs, which may
  show the home, so until the owner answers question 4 the link fails closed:
  it is not issued, and one issued before stops answering when protection is
  recorded (control H4).
- **The photographs it shows.** The handler chooses them among the issue's
  images, the reporter's photographs and those a handler attached, and the
  screen says that a photograph may show people. A file is served through the
  link only while it is chosen for that work order and still on that issue, or
  was added through that work order's link; any other identifier beside the
  token is answered with the refusal (control C3).
- **What the contractor sends.** Notes of at most 2,000 characters, scanned for
  personal identity numbers as the report form is, and photographs, identified
  from their bytes, stripped of their metadata, at most 40 megapixels, named
  by the server (`work-order-photo.<ext>`) and declared as showing people.
  Every photograph read through the link, the board's as well, is served
  under that server-made name, never under the name it was stored with. Both
  are part of the issue's free-text layer
  ([ADR 0057](0057-purging-issues-in-two-layers.md)): removed on the board's
  clock with the rest, and redacted by a handler as a note or a file is. The
  answer itself (accepted, declined, done, and when) is a fact about the work
  and stays with the building record. Nothing a contractor sends reaches the
  reporter's page or the reporter's own reads of their files.
- **Numbers.** Per client address and minute: 30 page reads, 120 photograph
  reads (a page shows up to thirty), 5 answers and notes, and 3 photographs.
  Per work order, in the database: 10 notes an hour and 50 in all, and 5
  photographs an hour, 10 in all and 30 MiB together, beside the per-file
  `OPENBRF_MAX_UPLOAD_BYTES`. A text post is refused past 64 KiB before it is
  read; the photograph is bounded by the multipart parser's per-file limit.
- **Reads write nothing.** Opening the page or a photograph writes no row, no
  audit entry and no timestamp, because mail scanners, chat unfurlers and link
  previews open every link they see (control E1). The consequence below that
  had the token's read audited against the work order is replaced by this.
- **Answers that end the link** are answered with a page of their own in the
  response, carrying no address of the link, because a redirect to the link
  would meet the refusal (control E6).
- **The handlers are told.** An answer, a note or a photograph queues the
  handler notice of the issue mailer (decision 21: the issue's number and type,
  never a word the contractor wrote), to the assignee or, with none, to the
  type's handlers. A note or a photograph is mailed at most once an hour per
  person and issue; an answer is mailed every time, because a decline or done
  is the act a handler must not miss and a link takes two answers at most.
  The answer is a
  step on the issue's timeline. A reporter's data subject access report says,
  under each work order, whether a link was given and how many of the issue's
  photographs it showed, by number and never by file. The number comes from a
  record the handler's acts leave (issuing a link, and choosing a photograph
  while a link stands), one row per photograph, so a changed choice or a
  removed file does not shorten it.

### The mailed work order

The fallback is built first, because it is what a release ships with whatever
the review says, and it asks nothing of the switch. Building it took a provisional
answer to three of the open questions below. Questions 2 and 4 stand until the
owner answers them; question 3 conflicted with the owner's own plan, was put to
the owner, and is answered:

- **Question 2.** The contractor register holds an email address beside the
  name, the trade and the telephone number, optional, and a contractor without
  one is listed and offered for no work order.
- **Question 3, answered by the owner on 2026-11-03.** The mail is the work
  order: the handler's text, the contractor's name in the greeting and the
  association's in the heading, and nothing else from the issue; a text holding
  a personal identity number is refused. The issue module's plan says both that
  no mail carries free text, the reporter's or the handler's, so that nothing a
  person wrote passes through the mail provider (decision 21), and that a work
  order is mailed while the contractor's link is off (decision 25). A mailed
  work order that carries no free text says nothing a contractor can act on, so
  the two could not both hold. The owner chose to keep the mailed text: a work
  order to a contractor is an exception to decision 21, and the only one. It is
  narrow by construction, and stays an exception only while it stays narrow: the
  server sends only what the handler previewed, the mail carries nothing else
  from the issue (no report, no reporter, no photographs, no link into the
  application), and a text with a personal identity number is refused. Every
  other mail about an issue keeps to decision 21. The first work order mailed
  to a contractor also links the association's privacy notice on its public
  website (GDPR art. 14(3)(b)), which is nothing from the issue and no link into
  the application ([ADR 0057](0057-purging-issues-in-two-layers.md#the-contractor-register)).
- **Question 4.** A work order on an issue whose reporter has protected personal
  data is not refused. Nothing of the issue goes into it but what the handler
  writes, and the form tells the handler to keep the reporter's name and home
  out of it and arrange access through the board.

The work order is stored with a copy of whom it went to, the text and who sent
it before the mail is put on the queue, in one transaction, and the mail is
sent at most once; a sending that fails says so on the work order with a code,
and one that may have gone out says that nobody knows rather than that it did
not.

Who receives the work order and what it says are what was previewed, and the
server holds the sending to them. The preview returns a signature over the
issue, the handler, the contractor, the recipient's name and address and the
text, valid for half an hour, and the sending is refused unless what it would
send now matches it. The rest of the mail is not signed: its subject, its
heading and its language are rendered when it is sent, from the association's
settings at that moment, so a change to the association's name or default
language in between shows in the mail and does not refuse it. The contractor's
row is locked while the sending reads it, so a board member who changes the
address at the same moment changes it either before the sending, which is then
refused and previewed again, or after it. The same text to the same contractor
on the same issue within half an hour, as long as a preview lasts, is refused
as a second press. So is any text while an earlier work order to that
contractor on that issue, created inside that half hour, has had its text
redacted: its words are gone, so a repeat cannot be told from a new order, and
a handler who redacts a mistaken order and writes a corrected one sends it when
the half hour has passed. An earlier work order known not to have left the
instance does not count: its handler is told to write it again. One handler
may send twenty work orders an hour.

The audit entry names the issue, the work order, the contractor and the sender,
with the length of the text and none of its words. Each change to the
contractor register is audited too, by the contractor's id and the fields it
touched, because an address changed there changes who receives what a handler
writes. The contractor's telephone number and address, and the work order's
copy of the address, are encrypted with their row's id as context.

A contractor switched off stays named on the work orders sent them. A
contractor removed from the register is erased from them as well: the copy of
the name and address on each is cleared, and the work order stays, saying that
it went out, when and what it said. That is how a sole trader's erasure is
honoured; the owner confirmed both on 2026-11-03. The nightly purge takes a
contractor off the list ten years after the last work order sent them; a work
order sent them that still holds its text, or is on an issue under a legal hold,
keeps the copy of their name and address for as long as it keeps its text or
the hold stands
([ADR 0057](0057-purging-issues-in-two-layers.md#the-contractor-register)). The text of a work order is
erased 3,653 days after its issue was closed, so never before the tenth
anniversary and up to a day after it, by the nightly purge, unless a
handler redacts it before then ([ADR 0057](0057-purging-issues-in-two-layers.md#redaction)),
which leaves the work order with whom it went to and when. The owner
asked for it to be kept as long as the law allows, to keep the history of what
was asked of whom. Ten years is the ordinary retention window chosen for that,
not a period the law sets for this text: the text is the association's evidence
of what it ordered, and the general limitation period for a claim about the
work is ten years (preskriptionslagen (1981:130) 2 §), so the window is sized
to a claim made in the ordinary course. It runs from the closing of the issue,
and the system knows neither when the work was done nor when a claim arose.
Bookkeeping needs less, to the end of the seventh year after the financial year
(bokföringslagen (1999:1078) 7 kap. 2 §). Storage limitation (GDPR art.
5(1)(e)) asks for a purpose, not a number of years, and the purpose here is
that evidence; the window is the association's answer for the ordinary case,
and the exceptions below are where it does not hold. A legal hold or a
restriction against the issue's reporter keeps it longer, and so does a legal
hold on the issue itself, which a handler places at `POST /api/issue-queue/:id/legal-hold` (ADR 0057): the purge skips the text
while it stands, and a redaction is refused. A dispute with the contractor that
interrupts the limitation, which starts a new period (preskriptionslagen 5-7
§§), is not seen by the clock: unless a handler places the hold on the issue,
the text is erased when its 3,653 days have run, and a claim still open under
preskriptionslagen loses its evidence. Placing the hold is the handler's act,
not the system's. A reporter's data subject access report lists, under each of their issues, the
work orders sent about it: to whom, when, and whether the mail went out, not
the text, which may be about other people.

The worker claims a work order and reads what it mails in one statement, a
conditional update that returns the recipient and the text, and it claims only
a row that still holds both. An erasure that commits before the claim - a
contractor removed, or the text purged or redacted - therefore leaves nothing to mail, and
the work order is recorded as not sent, with the code for the contractor
removed or for the text erased. An erasure that commits after the claim cannot
recall a mail already being sent, which is the one case the claim leaves open.

The claim also refuses a work order whose issue is ring-fenced, and takes the
issue type's lock before it does, the lock under which the board ring-fences a
type. A ring-fence that commits while a work order waits on the queue is
therefore read by its claim: the work order is not mailed, and is recorded as
not sent with a code of its own. A ring-fence set while a claim holds the lock
waits for it, and, like an erasure, cannot recall the mail that follows.

A ring-fenced type is a column on the type, `ringFenced`, read by the refusal
and set by the board under issues:configure through a request of its own,
audited with who set or lifted it. Which types are ring-fenced by default, and
when the ring-fence may be lifted, is ADR 0054's interim answer to its question 5.

## Open questions

Calls the plan does not make, left to the owner and listed on the task that
wrote this record:

1. **How long a reporter's link stays usable.** Answered by the threat review's
   control B4 and built that way (see [Expiry and revocation](#expiry-and-revocation)):
   the link ends at the first of 30 days after closing and 365 days after the
   issue's latest message (or after the day the link was issued, if no message
   came). The owner may set other numbers; each is one constant.
2. **How a contractor's link reaches the contractor.** The register the plan
   describes holds a name, a trade and a telephone number (decision 23), so it
   has no address to mail the link or the work order to. Answered
   provisionally under [The mailed work order](#the-mailed-work-order).
3. **A mailed work order and decision 21.** Decision 21 puts no free text in any
   mail. A work order mailed under the fallback of decision 25 is the handler's
   own text; whether decision 21 reaches it. Answered by the owner on
   2026-11-03: a work order to a contractor is the one exception to decision 21,
   under [The mailed work order](#the-mailed-work-order).
4. **A work order on an apartment whose household has protected personal data.**
   The contractor needs to know where to go. What the work order may say, and
   whether such a work order is refused, as the plan's research proposes.
   Answered provisionally under [The mailed work order](#the-mailed-work-order).
5. **Whether a contractor may send anything but a photograph**, such as a PDF
   report. This record allows images alone, as the plan says photographs.

## Consequences

- The issues module keeps no `@Public()` route in its application controllers,
  and the comment over `IssueReportController` names the two site-layer
  controllers (`SiteIssueLinkController`, `SiteWorkOrderLinkController`) as the
  only ways in without a session.
- `@PublicRateLimit`'s comment gains the token reads as the exception to its rule
  on `GET`.
- The work order's service refuses every act on a ring-fenced case, and the
  contractor's token lookup refuses a work order on one, each with a test that
  fails when the refusal is removed.
- `MediaService` gains a read by a token's grant
  (`openForWorkOrderLink`), which writes nothing (control E1, above), and a
  join other than `IssuePhoto` (`WorkOrderFile`) for photographs the reporter
  must not read, which `issueFileAccess` opens to the issue's handlers alone.
- The audit channels gain one for a link holder, with its row in the data subject
  access report's "Via" column.
- The record of processing activities names a contractor as a recipient (art.
  30(1)(d)), which `recipientsFor` has no branch for today; whether a contractor
  is a third party or a processor is on the legal brief.

---
"@openbrf/api": minor
"@openbrf/web": minor
"@openbrf/i18n": minor
"@openbrf/shared": minor
---

The issue module: case handling for the board and a property manager (ADR 0054,
0055, 0056 and 0057). Issue types and their statuses are the board's own data.
An issue has an assignee, a priority and a target date, and the issue queue
has the views Mine, Unassigned and Overdue, with a filter and a search. The
handlers write with residents on the issue, and with a reporter who has no
account through a private link; they keep internal notes and files of their
own. A handler previews a work order and mails it to a contractor, and the
board makes a charge from an issue. A link through which the contractor answers
a work order is built and ships switched off. Issues can be marked as
damage cases, and an issue type can be ring-fenced to the board. A reporter's
reply reopens a closed issue, and duplicates are merged. An issue's free text
is kept for a period the board sets while its building record stays.
Connected apps and the AI package can assign and move issues.

## Upgrading

- **The search's extension.** The database server has to offer PostgreSQL's
  `pg_trgm` extension. The bundled database includes it, and the migrations
  create it without a superuser. Where the server already holds it in another
  schema, the schema owner needs `USAGE` on that schema. `docs/deployment.md`,
  "The search's extension", says more.
- **Free text is removed on the first night.** From the first night after
  upgrading, the free text of every issue closed more than two years earlier
  (730 days, a year counted as 365 days) is removed, at most 500 issues in each
  run, oldest closing first. A board that wants to keep it longer sets a longer
  period under Settings before that night. An issue of a type the board has
  ring-fenced before that night loses its free text after one year instead,
  the period every instance starts ring-fenced types at, unless the board sets
  a longer one for them first. A legal hold on the issue or on its reporter, or a
  restriction of the reporter's processing, stops the removal; a board that
  answers a data subject access request about these issues says so, and checks
  what was actually removed rather than reading it from the date.
- **Types and statuses.** Types with the same name are merged into one offered
  to all of their audiences, as long as they agree on being switched on: the
  switched-on ones of a name merge into one type and the switched-off ones into
  another, so an audience the board had closed stays closed. Every issue moves
  onto the default status of its old status's meaning and keeps its closing
  date and history; an issue closed earlier has no outcome. Every existing type
  files at normal priority with no default assignee, and is handled by every
  handler, except a type for disturbances or insurance (see "Damage cases and
  ring-fenced issue types" below). Every existing issue is unassigned, at
  normal priority, with no target date. Existing issues are numbered in the
  order they were filed.
- **Starting data.** An instance already set up gets two saved replies and nine
  common areas, in its own language. A new instance also starts with a Swedish
  set of issue types, so the website's form takes a report from the first day.
  The set includes a water leak type filed as urgent, an insurance type the
  board handles alone and offers to no reporter outside the board, and a type
  for disturbances between neighbours that is ring-fenced and offered to
  residents.
- **Record of processing activities.** The issues row names the mail server and
  the contractors among its recipients, counts board members and former
  residents among its data subjects, says what the mails contain, mentions work
  orders in its purpose, and says that a ring-fenced issue is never mailed
  about and has its own retention period and that a damage case places a legal
  hold. A row the board has not edited is updated at the next start. A row the
  board has edited keeps the board's words, so a board that edited it should
  add these points itself.
- **The contractor's link is switched off.** Its legal review is done and left
  one question open: whether asking a contractor for notes and photographs
  through the link makes them a processor for the association rather than a
  recipient. The link stays off until that is answered. An association that sets
  `OPENBRF_CONTRACTOR_LINKS_ENABLED=true` before then takes that question on
  itself. Work orders are mailed either way.
- **The reverse proxy's access log.** The path of a reporter's private link and
  of a contractor's link is the credential. Keep `/arende/` and `/arbetsorder/`
  paths out of the proxy's access log; `docs/deployment.md` says how.
- **Website addresses.** A new page can no longer be given the address
  `/arende`, `/case`, `/arbetsorder` or `/work-order`. A page that already has
  one keeps it, and its contact and issue report forms keep working.
- **The MCP Connector.** The connector is offered only the actions whose
  personal data its manifest declares, and its manifest declared none. See
  "Connected apps and the AI package" below.

## Issue types and statuses

An issue type is one row with the groups who may report it: any of the
website's form, signed-in residents and handlers alone. Every type has its own
statuses, each belonging to one of four fixed status meanings: new, in
progress, waiting and done. A type starts with one status of each meaning, and
the board can rename them, add its own, switch one off and choose which status
of a meaning an issue enters by default. Moving an issue into a waiting status
asks for the waiting reason (the reporter, a contractor, parts or a decision),
and closing one asks for the outcome (fixed, the tenant-owner's
responsibility, no fault or referred).

A report is checked against its type again when it is filed: a type switched
off, or no longer offered to the reporter, while the report was being sent is
refused, and the report enters the default new status the type has at that
moment.

The queue is ordered by meaning, then by the board's order of the statuses
within a meaning, then oldest first. The purge of a public report's contact
details, the reporter's own list, the badge on a post, the overview and the
data subject access report read the meaning and never the board's label.

The audit log records each change the board makes here, with the board member
who made it: adding, changing or removing a type, and adding or changing one of
its statuses. A change to a type names the fields that changed, with the
setting before and after for who may report the type, who handles it, its
default priority and whether it is switched on. Of the type's name, a status's
label and the default assignee it records only that they changed. A save that
changes nothing writes no entry. Ring-fencing a type that someone other than
the board handled also records the handling it moved from, and whether it
cleared the default assignee.

## Handling an issue

- **Assignee.** A handler gives an issue to one person, gives it to somebody
  else, or leaves it unassigned. Only people the issue lets in can be chosen,
  and the list of them gives names and nothing else.
- **Priority and target date.** Urgent, normal or low, and the day the issue is
  meant to be done by. An issue past that day and not done is overdue. Nothing
  counts time from either, and a reporter never sets the priority.
- **Defaults per type.** A type files its issues with a priority and, if the
  board names one, an assignee. A type with no assignee, or one whose assignee
  no longer handles it, files its issues unassigned.
- **Who handles a type.** Every handler, or the board alone: a board member
  with a seat, or an administrator whether or not they hold a seat. A single
  issue can also be closed to all but the board. The property manager is not
  shown such an issue or type in the queue or through the actions, is not
  served its photographs even from an address opened before, does not see its
  status on a post in the feed, and does not count it. A property manager who
  reported the issue keeps what its reporter sees. Handing a type to the
  board, or closing an issue to it, unassigns a property manager who was its
  assignee.
- **Issues a handler opens.** Any handler, the property manager included,
  opens an issue for a named resident, who becomes its reporter, or an internal
  issue with no reporter. The resident is chosen by apartment and then from
  the people living there today; the picker has no search, and a resident with
  protected personal data is listed as protected and never by name. Each list
  of an apartment's residents is recorded in the audit log with the apartment
  and how many were listed, not who.
- **Timeline.** Each issue has a timeline of who did what and when, read from
  the audit log. A handler with protected personal data is never named on it.

## The issue queue and the board front page

- **Queue views.** Mine, Unassigned, Overdue (open issues past their target
  date) and All, each with its count. The queue opens on Mine, and the address
  names the view. An overdue row, and the Overdue count while above zero, are
  shown in the danger colour.
- **Filter and search.** A status filter (open issues by default, one status
  meaning, or closed issues as well), a type, a priority and a common area
  narrow every view. The search matches each of its first six different words
  in an issue's description, free-text location, common area, type, apartment,
  reporter's name, issue messages or internal notes. Case does not matter, and
  a percent sign, an underscore or a backslash matches itself. It never
  matches a reporter with protected personal data by name or apartment, and
  never finds an issue the reader does not handle. Each count is taken under
  the same filter and at the same moment as its list.
- **The board front page.** The issues row shows how many issues are open,
  overdue and unassigned, each linking to its view. The overview's line now
  counts unassigned open issues rather than new ones.
- **API.** `GET /api/issue-queue` takes `view` (`MINE`, `UNASSIGNED`,
  `OVERDUE`, `ALL`), `meaning` (a status meaning or `OPEN`), `typeId`,
  `placeId` (only the issues that name that common-area place), `priority` and
  `q`, and refuses a parameter it does not read; without any it
  still lists every issue the reader handles. `GET /api/issue-queue/counts`
  takes the same filter without `view`, `placeId` included. `GET /api/issue-queue/snapshot` takes
  the parameters of `GET /api/issue-queue` and answers `{ issues, counts }`,
  read in one transaction. None of them is an action.

## Conversation, internal notes and files

- **Issue messages.** A resident writes on their own report, and a handler
  answers in the queue, signed to the reporter by the board or the property
  manager, never by a person. A handler with protected personal data is not
  named to anyone. A reporter's reply on a closed report reopens it
  within 30 days (see "Reopening by a reply" below); after that, or on a merged
  report, the reply is refused. A handler cannot write to an internal issue,
  and writes to the reporter of a report from the website's form only while
  their private link works.
- **Internal notes and handlers' files.** Handlers write notes and attach an
  image or a PDF, such as a quote or a protocol, for each other. The reporter
  never sees them, and a handler the issue no longer lets in cannot open them.
- **Saved replies.** The board writes saved replies under Settings. The two an
  instance starts with, one acknowledging the issue and one saying that the
  bylaws and the law decide whether what was reported is the tenant-owner's to
  maintain, are templates for the board to reword.

Text a handler writes, in a message, an internal note, a saved reply, a known
fault, a message to the reporters of merged issues or an entry permission note,
is refused while it carries a personal identity number. What a reporter writes
is stored as written. Writing a message or a note is recorded in the audit log
with who wrote it, never what. The purge detaches a purged person from what
they wrote and leaves the words with the issue.

## The reporter's private link

When somebody reports an issue on the website's form and leaves an email
address, they are mailed a private link to a page for that issue: its type,
where it stands and the conversation, where they write back, text only.
Without an address there is no link. The page never shows an assignee, a
handler's name, an internal note, the priority, a waiting reason or what the
reporter wrote on the form.

- **The mail** carries the type and the link and nothing anybody wrote. It is
  sent once per issue; when the mail server accepts it but recording that
  fails, the retry mails a new link and the earlier one opens nothing. At most
  three go to one inbox a day, however its address is spelt (a tag after `+`,
  or the dots of a Gmail address), at most 30 an hour from the instance
  unless `OPENBRF_REPORTER_LINK_MAILS_PER_HOUR` sets another number, and none to a person who
  restricted processing. Past a limit the report is filed and no link is
  mailed, and the form answers the same.
- **It ends** at the first of: 30 days after the issue is closed, a year after
  the issue's latest message (or after the link was issued, if no message
  came), and a handler withdrawing it. A handler sees whether it still works.
  Every link that opens nothing gets the same page, which says that a new
  report can be made on the association's website if it takes them.
- **Limits.** Thirty page reads and five messages a minute from one address,
  and ten messages an hour and a hundred in all through one link. Of a link's
  messages, five in an hour are mailed about to whoever handles the issue; the
  rest are stored and shown without a mail.

## Mail

Whoever handles an issue is told by email, and every issue has an issue
number, shown in the queue, on the reporter's own list and in every mail.

- **Who is mailed.** A new issue goes to its type's default assignee, or to
  everybody who handles the type when it lands unassigned. An urgent issue, or
  one raised to urgent, goes to everybody who handles its type. An assignment
  mails the new assignee, once within the same clock hour. The assignee is
  reminded once, the morning after the target date, while the issue is not
  done; a new target date that passes gives a new reminder. A reopened issue
  goes to its assignee, or to everybody who handles it. A reporter's message,
  signed in or through the private link, mails the assignee, or everybody who
  handles the issue; a handler's message
  mails the reporter when they have an account; an internal note and a known
  fault mail nobody.
- **Who is not.** Nobody is mailed about their own action. A board-only issue
  is never mailed to the property manager. A person whose processing is
  restricted is not mailed: the restriction is checked when the mail is
  queued, when it is delivered and after the address is decrypted. No lock is
  held while the mail service sends, so a restriction or board-only change
  committed in that last moment can still be followed by one mail, with no
  free text in it.
- **No free text.** A mail greets its recipient by name and gives the issue
  number and type; a handler's also gives the priority, a link to the queue
  and, for a reminder, the target date. A mail never includes what the
  reporter or a handler wrote, where in the building the issue is, or who
  reported it, so that text does not pass through the mail provider. The one
  exception is a work order, whose mail carries the handler's text (see "Contractors and work orders"), including any place in the building the handler
  chose to write in it.
- **Bounds.** Handlers get mail about at most ten ordinary and ten urgent
  reports an hour from the website's form. Each signed-in reporter has five
  ordinary and five urgent reports an hour, and ten of their own messages an
  hour across all their issues. Past a bound, the report or message is still
  stored and shown, but nobody is mailed about it.

## Entry permission, common areas and inspection findings

- **Entry permission.** On an issue about an apartment, the resident who
  reported it answers whether the association or a contractor may enter, and
  for a yes whether there are pets, whether the master key may be used, a
  short note and the last day it stands. A yes is accepted only from a reporter who still
  lives in the apartment. A handler can record the answer from a telephone
  call. A note that reads like a door code is refused and never stored. The
  answer is cleared when the issue closes, when the purge detaches its
  reporter from an issue whose text is gone, and when the apartment is removed
  from the register. The audit log records only that an answer was given,
  which answer and whether the reporter gave it.
- **Common areas.** The board keeps a short list of common areas, such as the
  laundry room, the lift and the yard, under Settings, and a report can name
  one beside its free-text location. An issue about an apartment names no area.
  The queue shows how many issues each area has, closed ones included, so a
  recurring fault is seen. An area an issue names is switched off, not
  removed.
- **Inspection findings.** A handler marks an issue as a finding of a
  ventilation inspection (OVK), a lift inspection or a fire inspection, with
  the day, the protocol (a handlers' file) and a target date the Overdue view
  and reminders read. A lift finding's date must fall within a month of the
  inspection (BFS 2025:11, 1 kap. 17 §). The first mark places a legal hold
  on the issue; taking the mark off leaves the hold.

## Cost responsibility, charges and the responsibility guide

- **Cost responsibility.** A handler records whether the association, the
  tenant-owner or nobody yet clear pays. It is internal like the assignee, on
  the timeline and in the audit log, and listed in the reporter's data subject
  access report. An issue never carries an amount.
- **A charge from an issue.** Creating a charge from an issue opens the charges
  screen filled in with the issue's apartment or reporter and a reason naming
  its type; the amount is stored only on the charge, which names the issue.
  Removing the charge leaves the issue, and an issue purged or merged away
  leaves the charge. A board member who may read charges sees an issue's
  charges beside it; the property manager does not. The printed debiting list
  and its file do not name the issue. While the reporter has protected personal
  data, the issue's charges are shown as withheld and the debiting list on
  screen does not link them to the issue; a data subject access report masks
  the link too, except in the person's own report.
- **Responsibility guide.** The board edits a table of who maintains which
  part of the home and the building under its own bylaws, starting from an
  example that stays labelled as one until the board says it follows the
  bylaws. Handlers see it; residents and the public website's report form see
  it only once the board has adopted it. A line holding a personal identity
  number is refused. The audit log records each save that adopts the guide,
  withdraws its adoption or changes its lines, with the board member who saved
  it, and never a line's text.
- **Notice to remedy.** Where a handler records that the cost is the
  tenant-owner's, or closes an issue as their responsibility, the screen says
  that a message on the issue is not a notice to remedy under BRL 7 kap. 12 a
  §. A notice to remedy is sent outside Open BRF, for example by registered
  letter to the tenant-owner's usual address, which counts as given even if the
  letter is not collected (7 kap. 32 §); sent in another way, the association
  needs to be able to show that it arrived.

## Damage cases and ring-fenced issue types

- **Damage case.** Any handler the issue lets in marks it as an insurance
  damage, with the insurer, the claim number, the day and the cause. The first
  mark places a legal hold on the issue that stays until a handler releases
  it, also after the mark is taken off. The insurer and the claim number are
  refused while they hold a personal identity number, and the audit log and
  timeline record only the cause and the day.
- **Ring-fenced issue type.** Handled by the board only: the property manager
  never reads, counts or is given one of its issues and is unassigned when a
  type is ring-fenced. No work order is written on one, and nothing about one
  is mailed, to a handler or its reporter. No issue is merged across the
  ring-fence, and a type is not ring-fenced while one of its issues is merged
  with an issue of a type that is not: the board reopens the duplicate first,
  which undoes the merge. A connected app and the AI package are offered neither its issues
  nor the type. No report under it is made from a post, and the website's form
  offers none. The ring-fence cannot be lifted once anything has been reported
  under the type; a type ring-fenced by mistake is switched off and replaced.
- **Upgrading hands a type for disturbances or insurance to the board.** An
  existing type named exactly `Störningar` or `Störning`, or `Försäkringsärende`,
  `Försäkringsärenden` or `Försäkring`, is handled by the board only after the
  upgrade, as the matching types a new instance starts with are. Case and the
  spaces around the name do not matter. No other name is matched: a type
  called `Driftstörningar`, or one named in another language, stays with every
  handler. The board can open the type to every handler again in the settings,
  or keep another type to itself there.
- **Upgrading ring-fences nothing.** A board that wants its type for
  disturbances ring-fenced, as a new instance's is, takes it off the website's
  form and ring-fences it in the settings. The issues already reported under it
  are then ring-fenced with it, and the ring-fence cannot be lifted once the
  type has issues. From the next night, the nightly purge removes the free
  text of each of those issues that closed longer ago than the ring-fenced
  period, one year unless the board set another, unless a legal hold stands on
  the issue, or a legal hold or a restriction on its reporter. A
  board that may need those texts, as evidence in a dispute with a resident for
  example, places a legal hold first. From then on nothing about those issues
  is mailed, to a handler or to their reporter.
- **Its own retention period.** The free text of a ring-fenced issue is purged
  a number of years after it closes that the board sets under Settings apart
  from the other issues' period, from one to ten and one on every instance
  until the board changes it, unless a legal hold stands on the issue or a
  legal hold or a restriction on its reporter. The period may be longer than
  the other issues' or shorter. A change is recorded in the audit log, as a
  change to the other period is.
- **What the form asks for.** The warning on a ring-fenced type's form asks
  the reporter to describe what happened, what they saw and heard, and when,
  and not to accuse anyone of a crime, give the details of a police report,
  write who they think did it, or write about anybody's health.
  The form reads the types again when the report is sent: if the board changed
  how long the text is kept, or ring-fenced the type, while the form was open,
  nothing is filed, the new notice is shown and the reporter sends again.

## Reopening, merging and known faults

- **Reopening by a reply.** A reporter who replies within 30 days of an issue
  closing, signed in or through their private link, reopens it: it goes back
  to its type's default in-progress status, keeps its assignee and loses its
  outcome and closing date. After 30 days, or on a merged report, a signed-in
  reporter is offered a new report linked to the old one; a reporter with a
  private link is told to report on the website instead.
- **Merging duplicates.** A handler merges an issue into another still being
  handled, up to 200 into one. The duplicate closes with the outcome
  Duplicate; its reporter keeps their own report and sees where the other
  stands, and no reporter reads another's report. A handler can write one
  message to the reporters of the merged reports. Reopening a duplicate undoes
  the merge.
- **Known faults.** A handler publishes a short known fault, up to 280
  characters, on an open issue, signed by the board or the property manager.
  Signed-in residents see it above their report form and on the post the issue
  was reported from. It never appears on the public website or on an issue
  the board keeps to itself, and it goes when the issue closes.

## Contractors and work orders

- **The contractor list.** The board keeps the firms it hires under Settings,
  Issues and bookings: a name, a trade, a telephone number and an email
  address. Every handler, the property manager included, chooses from it;
  those who configure issue types change it. Removing a contractor also erases
  their name and address from the work orders sent them.
- **Sending.** A handler writes what is to be done and where and previews the
  mail as the contractor will receive it. The server sends only the previewed
  text to the previewed recipient, and asks for a new preview if either changed
  or the preview is over half an hour old. A duplicate within half an hour is
  refused, and one person may send twenty work orders an hour. A closed issue
  is offered none.
- **What the mail carries.** The handler's text and nothing else: never the
  report, the place, the reporter, the photographs or a link into the
  application. What the handler writes is sent as written, so a place or other
  personal data they put in it goes to the contractor. A text holding a personal identity number is refused.
- **The record.** Each work order is stored on the issue before it is mailed,
  with whom it went to, when, what it said and who sent it (GDPR art. 15(1)(c)
  and 19), and its mail shows as on its way, sent, not sent or unconfirmed. The
  audit log records the length of the text and none of its words. A reporter's
  data subject access report lists the work orders sent about their issues,
  with each one's text as the board weighed it.
- **Retention.** The text of a work order is erased ten years after its issue
  closed, following the general limitation period for a claim about the work.
  The erasure does not follow an interrupted or renewed limitation period: a
  legal hold on the issue, or a legal hold or restriction on the reporter, keeps
  the text longer. While the text stands, a public report's email address is
  kept in a coded form that cannot be read back, and an issue keeps its link
  to a reporter in the register.
- **Redaction.** A handler can remove a work order's text, asked twice; the
  work order stays, marked as removed by a handler with the date. It is refused
  under a legal hold on the issue or a legal hold or restriction on the
  reporter. A work order not yet mailed when its text is removed, or when its
  contractor is removed or its type ring-fenced, is not sent.

## The contractor's link

With `OPENBRF_CONTRACTOR_LINKS_ENABLED=true`, a handler gives the contractor
of a sent work order a link. Its address is shown once and passed on however
the handler chooses; a new link ends the old one. With the switch off,
handlers are offered no link and links given earlier refuse, opening again if
the switch is turned back on.

- **What the contractor sees.** The work order as written, the date it was
  sent and the photographs the board chose for it. Never the issue, its
  number, the report, the reporter, the conversation, a handler's name or
  another work order.
- **What the contractor does.** Accepts or declines, writes notes, adds
  photographs and marks the work done. The assignee, or the type's handlers,
  get the usual mail with no text from the contractor. The reporter never sees
  any of it.
- **Photographs.** Only JPEG, PNG, WebP and GIF identified from their bytes,
  stripped of location and camera details, at most 40 megapixels, stored under
  a name the server chooses. At most 10 photographs and 30 MiB per work order.
- **When it ends.** After 30 days, on a decline or done, or when a handler
  withdraws it. Also when the text is removed, the contractor is removed, the
  issue is closed or merged, its type is ring-fenced, or a person with
  protected personal data reported the issue or lives or is to live in its
  apartment. Reopening brings no link back.
- **Personal data.** The contractor's notes and photographs are part of the
  issue's free text. The data subject access report says, for each work order,
  whether a link was given and how many photographs it showed.
- **Limits.** From one address, 30 page reads, 5 answers or notes and 3
  photographs a minute. Per work order, 10 notes an hour and 50 in all, and 5
  photographs an hour.

## Retention, legal hold and redaction

An issue has two layers. The building record stays: the type, the status, the
outcome, the apartment, the priority, and when the issue was
reported and closed. The free text goes: the description, the free-text
location, the messages, the internal notes and every photograph and handler's
file, removed from storage and not only from the issue.

- **The period.** A nightly job removes the free text a number of years after
  the issue closed, set by the board under Settings from one to ten years; new
  and upgraded instances start at two. A year is counted as 365 days, so an
  issue is eligible at the first night after that many days, which can be a few
  days before the calendar anniversary of the closing. Eligible is not removed:
  a run removes the text of at most 500 issues, oldest first, and tries at
  most 1,000. An issue whose removal fails does not stop the scan, so a run
  can reach issues beyond the oldest 500. A file whose stored copy cannot be
  removed stays, with the text, until a later night succeeds. An issue of a
  ring-fenced type is eligible after the ring-fenced period instead, one year
  unless the board set another, unless a legal hold stands on the issue or a
  legal hold or a restriction on its reporter, so the other issues' period
  neither shortens nor lengthens it.
- **Legal hold on an issue.** A handler places and releases one. While it
  stands, the issue keeps its free text past its period and nobody can redact
  it. A legal hold or restriction on the reporter does the same for their
  issues.
- **Redaction.** A handler can redact the description, the location, a message
  or a note, and remove a photograph or a file, at any time. Nothing keeps the
  earlier words. This is how the board carries out an erasure request from
  somebody named in an issue another person reported.
- **Erasure requests.** A granted erasure request removes the free text of the
  issues the person reported on the night after it is granted. An issue still
  open, or under a legal hold, is kept until it closes or the hold is released,
  and the request stays open and says why.
- **Unattached files.** A nightly job removes a photograph or file uploaded to
  an issue but never placed on it, a day after the upload, at most 500 a run,
  keeping one whose uploader is under a legal hold or a restriction. When 20
  removals in a row fail, the run tries the newest file before it goes on: if
  that one fails too, as it does when storage is down, the run stops and leaves
  the rest to the next night, and if it is removed, the scan carries on past the
  files that fail on their own.

Every redaction, legal hold and change of the period is recorded in the audit
log with who did it, never the text or a file's name. A person's data subject
access report gives the date their issue's text was removed.

## Connected apps and the AI package

- **Reads.** `issue_list` and `issue_get` give the issue number, the status as
  its meaning and the board's label with the waiting reason and outcome, the
  type's reporter groups, the priority, target date, whether it is overdue,
  the assignee, whether a handler opened it and whether the board keeps it to
  itself. `issue_list` filters by `meaning` and `reporter`. `issue_type_list`
  gives each type's statuses, who handles it and its default priority. The new
  `issue_handler_list` gives the names of the people an issue may be assigned
  to. A protected person's name is withheld throughout.
- **Writes.** `issue_assign`, `issue_set_priority`, `issue_set_target_date` and
  `issue_set_status` need `issues:handle`. From a connected app each takes
  effect at once and is audited as coming through a connected app; the AI
  package only proposes, and the person confirms on the platform's own screen.
  Each answers with the issue's identifier and what changed, never the
  reporter, description or location. Closing through `issue_set_status` ends
  the contractor's links and clears the entry permission and known fault, as
  the board's screen does.
- **What stays inside.** An issue of a ring-fenced type, and one reported by a
  person with protected personal data, are answered as if they did not exist.
  No action reads or writes the conversation, an internal note, a work order,
  an entry permission, a merge or a known fault.
- **The MCP Connector** is offered `issue_set_priority` and
  `issue_set_target_date` already. The others are offered once its manifest
  declares their categories and the board consents: `issue_list` and
  `issue_get` need `name`, `apartment`, `freeText` and `health`,
  `issue_handler_list` and `issue_assign` need `name`, and `issue_type_list`
  and `issue_set_status` need `freeText`.

## Data subject access report

It lists the issues a person is assigned and the types that name them as
default assignee (type, status and dates, never the text or reporter), an
issue's cost responsibility and common area, an open issue's entry permission,
and the work orders sent about a reporter's issues. The purge clears a purged
person from assignments and detaches the work orders they sent, which stay
without the sender's name.

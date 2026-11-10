# @openbrf/shared

## 0.10.0

### Minor Changes

- 7e7cfcd: The data subject access report now gives the text of each work order, as the
  board weighs it under GDPR art. 15(4). Before, it gave only whom the work
  order went to and when.

  - **What the report gives.** On each issue the person reported, and on each
    issue that concerns them, every work order still shows whom it went to, when,
    whether the mail went out and whether a link was given. It now also gives
    what the handler wrote to the contractor, while that text stands. The text is
    given whole, given in part with words left out, or left out because it is
    about somebody else. On an issue the person did not report, it can also be
    left out because it would tell who reported the issue. The report never gives
    the contractor's address or who sent the work order.
  - **Weighed like an internal note.** The board weighs each work order from the
    report's screen, beside the issue's other texts. The screen names each work
    order by its recipient. A work order nobody has weighed is listed as not
    given, and the report is not printed until it is weighed.
  - **Removed and erased texts.** A text a handler removed says so, with the
    date. A text erased when its retention period ran out says that.
  - **Kept and purged with the text.** A work order's text has a clock of its
    own, ten years after its issue closes, and can outlast the rest of the
    issue's free text. Its weighing stays with it when the rest of the free text
    goes. It goes when the text does: when the ten years run out, when a handler
    removes the text, or with the work order. The audit log counts a work
    order's text with the other texts of the weighing.
  - **Wording.** The handlers' preview of a work order says that the access
    report can give its text once the board has weighed it. The record of
    processing activities' issues row says that the weighing goes with the
    work order's text. Both are in Swedish and English.

- 7e7cfcd: The data subject access report now carries the internal notes on the issues a
  person reported, and the issues that concern them where they are not recorded
  as the reporter.
  The board weighs what of their text is given, as GDPR art. 15(4) asks.

  - **The reporter's internal notes.** Each issue a person reported lists the
    internal notes on it by date, never who wrote them. The reporter never sees a
    note on their own screen, and a note may hold words about somebody else, so
    each one is given only as the board weighed it: whole, in part, or left out
    because it is about somebody else.
  - **Issues that concern you, where you are not recorded as the reporter.** A new
    section lists each issue a handler recorded as concerning the person, and
    where the person is not recorded as the reporter. It always gives the issue's number, type, dates, where it stands, how it ended,
    how many photographs it holds and whom it was sent to. Its description,
    location, messages and internal notes are given only as the board weighed
    each: whole, in part, or left out because it would tell who reported the
    issue or is about somebody else. It never names the reporter or any other
    source.
  - **Given in part.** Where a text can be given without the words that would
    tell who reported the issue or are about somebody else, the board takes
    those words out of a copy of it, made for that report, and the report gives
    the copy with each place marked […]. The copy can only take words out, never
    add or reword one, and every place it takes words out, at the start and the
    end too, carries the mark. The text itself stays as written on the issue and
    in every other report.
  - **Left out, with a reason.** The report prints the reason for each text left
    out, whole or in part, and none of the words left out. It also says that
    something was left out under art. 15(4) and that the person may complain to
    IMY.
  - **The board weighs on the report's screen.** Whoever may produce the report
    opens each such issue from it, reads its texts and gives each one whole, in
    part or not at all. A text nobody has weighed yet is listed as not given. The
    screen counts those texts and will not print the report until each one is
    weighed, from its own button or the browser's print. Nor will it print while
    a weighing is being saved, or before the report is produced again with it,
    so words the board has just left out are not printed from the report still
    on screen. A note written after the board weighed an issue is not given
    until it is weighed.
  - **One weighing per text.** The database holds each text to one weighing per
    report, and the report and the board's screen read the most restrictive one
    should two ever stand, so a second weighing can never give what the first
    left out.
  - **Purged with the text.** A weighing, and a copy given in part with it,
    goes with the text it weighs, with a handler's redaction of that text, with
    the record of whom the issue concerns, and with the issue's free text when
    the clock or a granted erasure request removes it. The audit log records the
    weighing against the person whose report it is, with how many texts were
    given whole, given in part and left out, and each time a board member reads
    an issue's texts to weigh them, with how many there were. It never names the
    issue or any of the text.
  - **Wording.** The handlers' hint on internal notes, the intro to whom an issue
    concerns and the record of processing activities' issues row say so in
    Swedish and English.

- 7e7cfcd: A handler records whom an issue concerns: the residents an issue is about who
  are not recorded as its reporter, such as the neighbour a report of a
  disturbance names. It works on an issue of any type.

  - **Picked as a resident is picked.** The handler chooses an apartment and then
    who lives there today, as when opening an issue for a resident. The list
    shows each person by name, or says that the name is protected. An issue names
    at most ten people this way. A handler takes a person off the list as a
    removal, asked twice.
  - **Read by the handlers alone.** Only those who handle the issue see the list.
    The reporter, the mails, a work order and the links carry none of it. An
    issue concerning a person with protected personal data is left out of what a
    connected app or the AI package reads, and a contractor's link to it ends.
    The audit log and the timeline say that a person was recorded, never whom.
  - **Purged with the issue's free text.** The record is personal data about the
    person named, so it is removed with the description and the conversation, on
    the issue's clock or on the reporter's granted erasure request. Whatever keeps
    that text keeps the record too. A legal hold or a restriction on a person an
    issue concerns now keeps the issue's free text and the text of its work
    orders, as one on its reporter does: the clock skips the issue, the reporter's erasure request counts it as kept,
    and a handler cannot remove its text. Where a work order's text still stands
    when the rest of the free text is removed, a bare reference to each person
    the issue concerns stays, which no handler reads, so that a hold or a
    restriction placed on the person later still keeps that text; it is deleted
    with the last of it. The record of processing activities and the board's
    settings say so in Swedish and English.
  - **On that person's access report.** The case reaches the person it concerns,
    without the reporter, also while only a work order's text of it stands (see
    the access weighing change).

- 7e7cfcd: The issue module: case handling for the board and a property manager (ADR 0054,
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
    and reminders read. The application requires a lift finding's date to fall
    within a month of the inspection. That is its own limit, not the legal
    deadline: BFS 2025:11, 1 kap. 17 § sets one month for a defect that is not
    immediate and remains after a recurring inspection, other findings have
    other requirements, and an immediate safety risk can prohibit use of the
    lift until it is put right. The board meets those itself; a date the
    application accepts does not show that it has. The first mark places a legal
    hold on the issue; taking the mark off leaves the hold.

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
    or a note, and remove a photograph or a file, at any time except while a
    legal hold stands on the issue, or a legal hold or a restriction stands on
    its reporter or on a person the issue concerns. The application refuses it
    then, so an erasure request about the issue waits until the hold or
    restriction is released. Nothing keeps the earlier words. This is how the
    board carries out an erasure request from somebody named in an issue another
    person reported.
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

## 0.9.0

### Minor Changes

- 15a1a44: The board can give a person who does not live here, such as somebody who rents
  a parking space, access to one plugin (ADR 0053). A plugin access is granted
  and withdrawn on the person's page in the address book, by a board member who
  may write the address book, and in the web interface only: no connected app,
  action or AI package can grant one. Both acts are in the audit log. No
  residency is created for the person. They get an account the way any person
  the board adds without a residency does, through the invitation sent from
  their page.

  A plugin access is only for a person who has never lived here. The grant is
  refused for a person with any residency on record, whether it is current, has
  ended or begins later. Recording a residency ends every access the person
  holds, in the same write, and that applies to a move-in, an approved account
  request and a member list import. The move-in form, the preview of a member
  list import and the queue of account requests say so before the board saves,
  applies or approves: the board is warned when exactly one person
  matches the email address, has no account and holds a plugin access. An address with an account, or
  one that two persons share, is refused at approval and ends nothing. An access
  goes when its plugin is removed.

  The person's page shows each access and the day it was granted, and the address
  book gains a tab listing the persons whose only tie to the association is a
  plugin access. The data subject access report lists a person's plugin accesses.

  An access can only be given to a running plugin that declares people given
  access among the callers its resident routes serve, and whose install consented
  to that class. The page offers no other plugin, and a grant to one is refused.
  The person is then served by that plugin's resident routes and offered its
  view. Protected personal data, a restriction and an objection to the plugin's
  processing still refuse them first, and an access to one plugin does nothing
  on another. A withdrawal takes effect on the person's next request.

## 0.8.2

No changes in this release.

## 0.8.1

No changes in this release.

## 0.8.0

### Patch Changes

- 52f228c: Control borders in the default theme now meet WCAG 1.4.11. `border-strong`,
  which the contract gives to control borders and input outlines, was `#B8B5AC`
  in light mode (1.75:1 on `surface-page`, 2.05:1 on `surface-raised`) and
  `#4A4B50` in dark mode (2.04:1 and 1.83:1). It is now `#817F7B` (3.41:1 and
  4.00:1) and `#747476` (3.81:1 and 3.41:1). Inputs, buttons and checkboxes
  across the application draw a visibly firmer outline, and so do the
  underlines, rules and quote bars that also use the token.

  The contrast matrix measures `border-strong` on `surface-page` and on
  `surface-raised` at 3:1, the new `NON_TEXT_CONTRAST_RATIO`, while text pairs
  stay at 4.5:1. A `ContrastPair` may state the ratio it is held to in
  `required`; one that leaves it out is held to `AA_CONTRAST_RATIO`. The theme
  lint refuses a theme whose `border-strong` falls below 3:1 on either surface,
  so a theme that passed before can now be refused: one that sets its own
  surfaces and keeps an inherited or faint `border-strong`, or one with no
  `border-strong` at all, whose value then falls back to `border-subtle`. A
  theme that only extends the default theme and leaves its surfaces alone
  inherits the new values and passes. A theme already installed stays
  installed and can still be activated, since activation checks only the
  statutory pairs.

  `primaryColorOverride` now refuses an association's colour only for the pairs
  that colour breaks. A pair the theme already fails, such as a `border-strong`
  in a theme installed before this check, no longer drops the association's
  colour from the application and the website.

- 3c3c232: `host.audit.record` now limits how fast a plugin writes audit entries, with two
  new token budgets that each hold a burst and refill continuously; an entry refused
  for its fields or its subject spends from neither. Entries on one person's
  requests share a burst of 30 with each plugin, refilling at 30 a minute
  (`PLUGIN_AUDIT_LIMITS.perPersonPerMinute`). The entry past it is refused with
  the new `PluginAuditRateError`, nothing is written, and the plugin keeps
  running, so no member can stop a plugin for everyone by making it audit them.
  Entries with no request, from the plugin's own jobs, share a burst of 120,
  refilling at 120 a minute (`PLUGIN_AUDIT_LIMITS.perMinute`). A plugin that
  writes past that is stopped with the new finding `audit-rate-exceeded`: the
  entry is refused and nothing is written, and every host service refuses the
  plugin until the application restarts, which switching the plugin off and on
  again does. The admin screen says why it stopped. Before this, a plugin writing
  in a loop could grow the audit log without bound, since an entry needs no
  permission and no purge removes it.

  The data subject access report now prints a plugin's text for an event as the
  plugin wrote it, with no interpolation or nesting, and cuts it at 200
  characters. A `$t()` in that text could otherwise print the core's words, or
  another plugin's, as the plugin's own.

  The record of processing activities now says when a plugin's row names no
  personal data: this record lists no categories, which does not mean the plugin
  handles none. Before, the list was empty, which read as a processing of no
  personal data at all.

## 0.7.0

### Minor Changes

- 5dd82d2: A plugin can now keep records about a person through `host.personRecords`
  (ADR 0047). Open BRF looks after those records the way it looks after its own
  bookings.

  A plugin declares each collection in its manifest under `personRecords`, with
  the personal-data categories it holds, how many days a record may be kept
  (at most 1 830) and the fields the data subject access report labels. A
  plugin that declares one also declares its `processing` and asks for
  `addressBook:read`. The install consent screen and `openbrf plugin add` name
  each collection with its categories and its bound, and the install refuses an
  entry that changed them in between. A
  republished version that adds a collection, holds more categories in one or
  keeps a record longer is not loaded until the board installs it again
  (`personal-data-widened`). The field is in version 2 of the catalog index.

  Every record names one person and the day it is erased, which must come after
  the day of the write. A new record may name only a resident the address book
  lists to the plugin on that day. The day of the write is the day the write
  runs, so a write that waited in the plugin's queue or for a lock past midnight
  is judged on the next day. A record about a person
  with protected personal data, under a restriction of processing, or objecting
  to the plugin's processing is hidden from the plugin. A moved-out person's
  records stay visible, so a plugin can tell from its own records that a person
  it keeps one about became one of these rather than moving out, though not
  which. Catalog review accepts a plugin only if its features need the records
  it keeps.

  - A record is gone from the plugin's view from the start of its erase date. A
    nightly job at 03:50 erases each record on its day, and erases every record
    about a person whose erasure request the board granted, without running the
    plugin's code. The request stays open until none is left.
  - A legal hold or a restriction stops both. While one stands, a record the
    plugin overwrites or deletes is set aside instead and kept, and so is a
    record past its erase date. Neither is visible to the plugin or counts
    towards its limits, so the plugin cannot tell from its records or its limits
    that a hold stands.
  - Removing a plugin deletes its records itself, rather than through the
    database, and sets aside the records a hold or a restriction keeps. The
    audit entry for the removal says how many it deleted and how many it set
    aside.
  - The data subject access report has a new section listing every record a
    plugin keeps about the person, set-aside ones and those of a removed plugin
    included. It is labelled from the plugin's own translations even when the
    plugin is switched off.
  - The portability export carries a record only where the plugin's processing
    rests on consent or the contract, and then only the fields the plugin marks
    as given by the person.

  A plugin's own records (`host.records`) now refuse a collection declared under
  `personRecords`.

  `host.addressBook.caller(request)` answers whether the person making a request
  is a resident the plugin may serve, without saying why when they are not.
  `host.audit.record` takes a `subject`, so an entry reaches the access report of
  the person it is about. Naming a subject needs `addressBook:read` or
  `addressBook:readContact`.

  The reference plugin in `fixtures/example-plugin` lets a resident note the days
  they are away, kept for 30 days after the last of them. Its manifest states
  that purpose, it refuses days beyond the collection's bound with a translated
  reason rather than a server error, and it keeps nothing on an instance without
  `host.personRecords`.

- 977fdc1: A board member can now see the application as a resident sees it, in a resident
  preview. "View as a resident", beside their name in the band and at the foot of
  the phone menu, starts it. The resident preview narrows what the application
  offers to what a resident and a member are
  granted: the board's section, the board's line on the overview, the board's
  signs and the board's controls on the house's pages are gone, the archive leaves
  out the board's documents, the feed leaves out the posts addressed to the board
  and to the administrators and the board's way of writing, the issue report form
  leaves out the board's internal issue types, and the phone bar is a resident's.
  The posts and comments that stay, the board's published news to the whole house
  among them, are shown as a resident sees them, in the feed and in the comments
  under the news: without the strike-through and the must-read list, without
  earlier versions of what somebody else wrote or an issue report made from
  somebody else's post, and without struck text or the status of an issue report
  that is not the reader's own. The report to the board, which a resident is
  offered on a post to the whole house, is not offered in the strike-through's
  place, because the server refuses it to a board member there. A bar under the
  band says the preview is on, on every page, and "Stop" in it ends the preview.

  A post's issue report in the feed now says whether the reader made it, so the
  preview can tell the reader's own issue report from one shown because the
  reader handles issues.

  Opening any page under `/board` ends the preview before the page loads, and that
  page says why. Signing out ends it too. The preview lasts as long as the browser
  tab: it is kept in the tab's session storage, never on the server, and the
  server keeps answering every request on the account's own capabilities, so the
  preview changes what is offered and never what is allowed.

  It is offered to an account that sees more than a resident and holds some of a
  resident's grants, which is a board member and the administrator. The property
  manager, who holds none of them, is not offered it.

## 0.6.0

No changes in this release.

## 0.5.0

No changes in this release.

## 0.4.0

### Minor Changes

- b6d0def: A plugin can now hand the board a member list to review, such as one emailed
  to the association (ADR 0043). It asks for the new permission
  `addressBook:proposeImport` and calls `host.imports.propose` with the file, CSV
  or XLSX, and, when its source has one, who sent it. The core reads the file
  exactly as it reads an upload and holds it as an import proposal. Nothing is
  written to the register until a board member has previewed and applied it on
  the import screen. A plugin cannot read the register through this permission,
  and it is told only the receipt, why a file was refused, and where its own
  proposals stand (`host.imports.status`). It can take one back with
  `host.imports.withdraw`.

  Proposals wait at the top of the import screen as "Proposed by" the plugin,
  with the file name, the row count, when the file arrived and the sender as the
  plugin reported it, and in the board's "To handle" queue on the overview. A
  board member opens one at the mapping step, with the mapping saved for that
  plugin's files when the column titles are the same, or rejects it. A plugin has
  one proposal waiting at a time: a newer file supersedes the one before, and a
  file holding the rows of the one waiting, or of the last one the board applied
  from it, is refused as unchanged. A proposal nobody decides expires after 14
  days. Decided proposals are listed below the waiting ones, and each record is
  deleted 90 days after it was decided. The audit log records that a plugin
  proposed a list, and that a board member rejected one, without the file name or
  the sender.

  Every import, uploaded or proposed, now deletes the rows of its file, its
  preview and its row decisions as soon as it has been applied or has stopped,
  rather than keeping them until the upload expires. The record of a proposed
  import is kept for the 90 days described above.

  A plugin that declares `addressBook:proposeImport` must declare the personal
  data categories `name`, `apartment`, `residency`, `email`, `phone`,
  `personalIdentityNumber` and `protected`, because the list it carries can hold
  all of them. The last two are new to a plugin's declaration and are refused
  without the permission. `protected` is also a category the association's record
  of processing activities can now name. The permission cannot be combined with
  `site:blocks` or with a device route. The install consent now asks whether a
  plugin sends personal data outside the instance or receives it from outside.

  The first release with this change is the minimum host release for a plugin
  that proposes imports: an older host refuses the permission in the manifest.

- 920a721: The AI package can now propose a general meeting's agenda. The board member who
  asked for it confirms the proposal before anything is written. The proposal
  replaces the whole agenda and names the agenda it was drafted against, so a
  proposal confirmed after somebody rewrote the agenda is refused as out of date
  instead of overwriting the newer agenda. The agenda cannot be changed once the
  notice has been issued or the meeting has been recorded as held. The confirmed
  change is recorded as the confirming board member's own, made on the web, and
  its audit entry names the proposal that led to it. The board's own meetings
  screen writes the agenda as before.
- 7a70a29: Let a plugin offer extension points and another plugin extend them (ADR 0030).

  A host plugin declares `extensionPoints` in its manifest, defines each point's
  input and output schemas with `host.extensions.define`, and calls the addons
  serving there with `host.extensions.list` and `host.extensions.invoke`. An addon
  declares `extends` and registers its handler with `host.extensions.contribute`.
  The host validates both directions against the host plugin's strict schemas and
  copies the values as JSON, and answers for what an addon does - not serving,
  timed out, failed, output invalid - in the result rather than by throwing. An
  answer longer than `EXTENSION_MAX_OUTPUT_LENGTH` as JSON is refused unparsed.
  A plugin that reads the register or proposes imports and one that asks for
  `site:blocks` do not extend each other, in either direction, and a website addon extends only a
  plugin that handles no personal data. Nor are the two joined through other
  plugins: where the plugins joined by extensions would hold both, the loader
  refuses the website addon (or, failing that, the addon that joins them) before
  its code runs, whatever order it finds the packages in, and the catalog refuses
  the index.

  Each addon is installed, consented to and switched on by itself, and never
  receives the host plugin's permissions. Its consent screen says what it extends
  and which personal data it hands over; the host plugin's says what its points
  accept. An addon whose host plugin is missing, switched off or removed does not
  serve, and the admin screen gives one of nine new findings
  (`extension-host-missing`, `extension-point-unknown`,
  `extension-version-unsupported`, `extension-personal-data-refused`,
  `extension-permission-refused`, `extension-host-personal-data-refused`,
  `extension-group-refused`, `extensions-widened`, `extension-refused`). The catalog index gains version 2,
  which carries both declarations; version 1 is still read. An index that lists an addon beside
  its host plugin is refused when the host's entry declares no such point, serves it at another
  version or does not accept what the addon's entry hands over; what the installed packages declare
  is still checked when the instance starts. Such a refusal, and those that hold an addon against the
  plugins it is joined to, carries the code of the matching finding, and `openbrf` prints it as a
  translated sentence above the catalog's own line.

  `PluginBlockAbortSignal` is now an alias of the new `PluginAbortSignal`.

## 0.3.0

### Minor Changes

- c198a01: List the news, the calendar, the broker information page and the account
  request form as built-in pages, and put them in the menu the way any page is.

  The website's page list now shows the four built-in pages beside the
  association's own, marked as built in. Opening one shows what stands on it,
  lets the board rename it, and links to where its content is written: the news
  screen, the events, or the account request setting. The broker information
  page's own panel is where the association facts it is made from are recorded.
  What stands on a built-in page stays the platform's, its address does not
  change, and it is always public.

  Adding a menu entry no longer has a separate choice for a generated page. The
  built-in pages are among the pages to choose from, and an entry left without a
  label takes the page's title. An entry can be kept for signed-in members with
  "Only for signed-in members", whatever it leads to. Every menu keeps its
  entries, their labels, their places and whom they are shown to when you
  upgrade, and the website's addresses stay the same. A button chooses a
  built-in page from the same list of pages, by the title the board gave it; the
  account request form is not offered to a button.

  For API clients: a menu entry's `kind` is `PAGE` or `EXTERNAL`, and
  `generatedKey` is gone; an entry for a built-in page is a `PAGE` entry with the
  page's id, and every entry carries `membersOnly`, which a change that leaves
  it out keeps as it was. Every page carries `builtIn` (`NEWS`, `CALENDAR`,
  `BROKER_INFORMATION`, `REQUEST_ACCOUNT` or `null`). A built-in page takes a new
  title and nothing else: a body, another address, another status, the front
  page and a delete are refused with `built-in`. The `menu_generated_keys`
  action is retired; `page_list` finds the built-in pages. A button block names
  a built-in page the same way, as `{ "kind": "page", "pageId": ... }` with the
  page's id, and has no other kind of destination for one. ADR 0027 records the
  model.

- cbb9891: The feed does four things a noticeboard does not (ADR 0026).

  **Unread, live.** The feed's entry in the navigation shows how many posts are
  unread across every audience you are in. On the feed, each post that is new
  since your last visit is marked new, pinned or not. Every audience's count
  refreshes with the feed's poll, not only the open one's, and the navigation's
  every thirty seconds on every other screen. Both pause while the tab is hidden.

  **A post becomes an issue report.** On a post you wrote, or as a board member on
  any post you can read, reporting an issue from the post opens the issue report
  form filled in with the post's text and images. Sending it links the report to the post, and
  the post then shows where the report stands. Only the report's reporter and
  whoever handles issues see that; the post does not show it to anybody else.

  **Must-read.** On a post the board marked important, the board can list who in
  the audience has not opened it yet, leaving out anyone whose processing is
  restricted. Everybody else sees the count, as before.

  **Edit with history.** You can edit your own post or comment, which is then
  marked as edited. You and the board can read the earlier versions; nobody else can.
  A post the board struck through can no longer be edited, and one post or
  comment keeps twenty earlier versions. The earlier versions are on your access
  report and are erased with the post.

  The board can also withdraw a post it scheduled, from the list of scheduled
  posts, until it is published. That includes a post scheduled for the board's or
  the administrators' audience, which the news screen does not list.

  API changes:

  - New endpoints: `PATCH /api/feed/posts/<post>`, `GET
/api/feed/posts/<post>/revisions`, `GET /api/feed/posts/<post>/not-read`,
    `PATCH /api/feed/comments/<comment>`, `GET
/api/feed/comments/<comment>/revisions` and `DELETE
/api/feed/board-posts/<post>`.
  - A post carries `issue`, `mayReportIssue`, `mayEdit`, `mayReadHistory` and
    `mayListNotRead`; a comment carries `mayEdit` and `mayReadHistory`; an
    audience carries `readAt`.
  - `POST /api/issues` takes an optional `postId`, and refuses it with
    `post-not-found`, `post-not-reportable` or `post-already-reported`.
  - New feed refusals: `not-editable`, `too-many-edits`, `history-withheld`,
    `not-important` and `not-scheduled`.
  - The access report lists the earlier versions of each post and comment
    (`earlierVersions`).

- a9f6b95: The board writes in the feed as Styrelsen (ADR 0026). In "Write a post", a
  board seat holder chooses "From": themselves, "Styrelsen", or "Styrelsen via"
  their own name. They also choose "To": Alla, Styrelsen or Administratörer,
  and, writing as themselves, the group that is open.

  Administratörer is a new audience in the feed: the instance's administrators
  and the board. It is the one audience the administrator is in, so the board can
  write to the people who run the instance and hear back from them.

  A post written as Styrelsen is a news item, and takes a title as well as its
  text. It is written and published in one act, through the news screen's own
  path and with the same audit entries. Written to Alla, it is published to the
  members on the website and in the news reader. Written to Styrelsen or
  Administratörer, only that audience reads it, in the feed: it is not on the
  website, the news screen or the news thread. The board's options come with it:

  - "Important message" sends the news mailing, exactly once. It goes to the
    members for a post to Alla, and to the audience alone for any other, with a
    link to the post in the feed.
  - "Pin to the top" pins it on top of the feed.
  - "Allow comments" (on unless unticked) decides whether it takes comments.
  - "Show on the association's website to everyone" publishes a post to Alla to the
    street.
  - "Schedule publication" holds it for an instant ahead.
  - "Preview" shows it as it will read, from Styrelsen.

  A scheduled post waits as a draft that only the board sees, listed beside the
  feed under "Scheduled posts". A job publishes it, mailing included, at its
  instant. It reaches every open feed with the next poll, even when the job runs a
  moment late. A post to Alla can be changed or removed on the news screen before
  then, as any draft can. If a board member publishes it there first, it appears
  in the feed at once, and the job does nothing when its instant comes.

  Under a post to Alla, Styrelsen or Administratörer, a board seat holder can
  answer as "Styrelsen via" themselves; the comment still names its writer. The
  news screen's thread reads such a comment as "Styrelsen via" its writer too. The
  board pins and unpins its own posts with the controls marked Styrelsen on the
  card.

  Only a board seat that has not ended speaks for the board. The server refuses
  every one of these to a resident and to the administrator, whatever a screen
  sends. It also refuses:

  - a post or comment written as Styrelsen into a group;
  - the website for a post anywhere but Alla;
  - an ordinary post carrying the board's options.

  API changes:

  - New endpoints: `POST /api/feed/board-posts`, and `PUT` and `DELETE
/api/feed/posts/<post>/pin`.
  - `POST /api/feed/posts/<post>/comments` takes `asBoard`, and `POST
/api/feed/posts` now refuses fields it does not know.
  - `GET /api/feed/audiences` answers `mayPostAsBoard` and may list an audience
    of kind `ADMIN`.
  - `GET /api/feed/posts` answers `scheduled`, and a post's news item carries its
    `text`.
  - A news comment, from `GET /api/news-comments/<news>` and the
    `news_comment_list` and `news_comment_hide` actions, carries `byBoard`.

- e5ac99f: The board moderates what the house writes in Alla, and its report queue reaches
  every report (ADR 0026). This completes the feed.

  **Striking through in Alla.** A board member strikes a resident's post or a
  comment in Alla through from the feed itself, without waiting for a report. The
  control sits with the board's other controls under the board's sign, and asks
  once more before it strikes, because a strike cannot be undone. The text, and a
  post's images, are then hidden from everybody else who reads Alla. The writer
  and the board still read them, and nothing is erased. A strike closes every open
  report of what it struck.

  **Reporting a post or a comment.** Residents can report a post in Alla to the
  board, and a comment under any post in Alla or in a group, as well as a post in
  a group as before. A comment's report carries the comment alone: from a group,
  the board sees neither the post it answers nor a way to reach it. In a group the
  board still acts only on a report, and a board member who is in the group is
  refused a strike there without one. Nothing in Styrelsen or Administratörer, and
  no post written as Styrelsen, can be reported or struck. Nobody can report their
  own post or comment, a board member cannot report what is said in Alla, where
  they strike instead, and one person can make ten reports in an hour. A post or a
  comment the reader has already reported is no longer offered for reporting, also
  after the page is reloaded.

  **A paged report queue.** The queue used to show the first fifty open reports,
  and nothing after them could be reached. It now reads fifty at a time, oldest
  first, and the next fifty are a press away. A report the board settled
  elsewhere, from the feed or by another board member, leaves the queue when
  pressed and says so. A report the purge has taken with what it was about leaves
  the queue the same way, once the first page is read again. When every report
  shown has been answered and more are waiting, the queue says so above the button
  that reads them, and a queue the board has emptied says that every report has
  been answered rather than that nothing was reported. The overview's count of
  reported posts says "at least" only when the queue has another page.

  `GET /api/feed/reports` takes an `after` cursor and answers with `next`. A
  report names a `postId` or a `commentId`, and carries the audience it came from.
  `POST /api/feed/posts/:postId/strike` and
  `POST /api/feed/comments/:commentId/strike` are new and need `chat:moderate`.
  Posts and comments now say whether the reader may report them (`mayReport`) and
  strike them (`mayStrike`).

  `POST /api/feed/reports` refuses a report the reader is not offered, and refuses
  a reader past ten reports in an hour with a 429. The access report names Alla,
  rather than "a group", for a report made there.

- c46aeff: Turn the chat into a feed underneath: one stream of posts and comments for the
  house, the board and each group (ADR 0026). This release changes the schema and
  the API; the screen still shows the chat's rooms, and the feed's own screen
  follows.

  Every post is for one audience. Alla is everybody who lives here and the board;
  Styrelsen is whoever holds a board seat, and is what the board chat was; and
  each group is an audience of its own. One check decides who is in an audience,
  and every path that reads or writes a post, a comment, a like or a read record
  asks it. A group and its posts are invisible to anybody outside it: on no list,
  in no search or filter, and a post asked for by its identifier is refused exactly
  as one that does not exist (ADR 0012). The administrator, who holds every
  capability and lives nowhere, is in no audience.

  The migration renames the chat's tables rather than copying them. Every message
  becomes a post in the audience its room became, with its identifier, its date -
  and so its purge date - and its strike unchanged, and every room's read markers
  become its audience's. Every news item that has been published becomes a board
  post to Alla at the instant it was published, and its comments become the
  post's: there is one comment model now. Publishing a news item puts it in the
  feed from then on.

  `GET /api/feed/audiences`, `GET /api/feed/posts` (newest first, pinned posts on
  the first page, filtered by audience, search, who wrote it and whether it is
  important) and `GET /api/feed/posts/since` (the poll, on the same
  `(createdAt, id)` cursor as before) read the feed; `POST /api/feed/posts` writes
  a post; a post has its own address at `GET /api/feed/posts/:id`, comments under
  `/comments`, a like under `/like` and a read record under `/read`, which the
  post reports as "read by N" and never as names. Groups and reports moved to
  `/api/feed/groups` and `/api/feed/reports`, and the old `/api/chat` routes are
  gone. The browser reads the same wire types the server writes, from
  `@openbrf/shared`.

  One purge erases a resident's post or comment a year after it was written, on
  its own clock, and takes a post's likes, read records, reports and history with
  it; a board post follows its news item. A post never takes a comment with it:
  each comment is its writer's, erased on its own date or its writer's granted
  erasure request and kept under its writer's legal hold or restriction. A post
  with a comment still under it is erased rather than deleted - its text and its
  author go, and the row stays as the place the comments answer, shown as erased
  (`erasedAt` on the post) and taking no comment, like or report, until the last
  comment under it has gone. The chat screen shows such a message as erased.

  A granted erasure request reaches all of it as one domain, `feed`, and the data
  subject access report states it in three sections: what the person wrote in the
  feed, audience by audience, with how many posts they liked and opened; their
  comments; and the posts they reported or answered.

  The capabilities `chat:participate` and `chat:moderate` and the chat's audit
  actions keep their names.

- 69cc696: The feed gets its own screen, at /app/feed, in place of the chat (ADR 0026).
  /app/chat now goes to the feed, and "Chat" in the navigation is "Feed".

  Posts are newest first with the pinned ones on top. Each one shows who wrote
  it - "Styrelsen", or "Styrelsen via" its writer - when, and to which audience,
  with the text as it was written, its line breaks kept and its web addresses
  made into links, and the images on it. Under it are "Like" with a count, the
  comments, which open under the post, flat and oldest first with likes of their
  own, and "Read by N": how many have had the post on their screen, as a count and
  never as names. The ⋯ beside a post copies its text, and in a group reports it
  to the board. Nothing deletes a post: the board strikes through.

  "Write a post..." opens the composer. A resident writes as themselves, to
  Alla from the whole feed or to the group or Styrelsen that is open. The text is
  required, and up to four images can be attached; they are uploaded as they are
  picked and the post is written once with them. "Preview" shows the post
  before it is created.

  The search field and "Filter posts" - the board's posts, the neighbours',
  important ones only - narrow the feed inside the reader's own audiences and
  never outside them. The panel beside the feed lists Alla, Styrelsen and each
  group with what is unread in it, and keeps making a group, putting a neighbour
  in and leaving one.

  Every post has an address of its own, /app/feed/<post>, which opens the post
  with its comments: what a news mailing, a report or an issue report can link
  to. A post in a group the reader is not in is refused there exactly as one that
  does not exist.

  Images on a post are stored like every other upload - identified from their
  own bytes and encrypted at rest - and served only to whoever may read the post,
  and not to the group when the board has struck the post through. The board
  sees a reported group post's images in the report queue, and is served them
  through the open report alone; each such serve is written to the audit log.
  They are erased with the post, an image uploaded for a post that was never
  written is removed after two days unless a legal hold or a restriction of
  processing stands over the person who uploaded it, and the access report counts
  the images on each of the person's own posts. New endpoint: `POST
/api/feed/images`; `POST /api/feed/posts` takes `imageIds`.

  An open thread receives the comments its neighbours write while it is open:
  it polls forwards from the newest comment it holds, paused while the tab is
  hidden, and after the reader writes it reads everything written since, however
  many pages that is. New endpoint: `GET
/api/feed/posts/<post>/comments/since?after=<cursor>`. A comment the board has
  struck through now says so in its own words rather than the post's.

- f51309d: Add a management API for whoever hosts an instance. It is off unless the
  operator configures a port and a token, answers on that port only, never on the
  public address, and returns one summary: the number of apartments, how many
  people the registers hold, whether residents have been invited, the day the
  board was last active, how often the register extracts have been generated,
  storage used, the running version and the state of the database migrations. It
  carries nothing about any one person. The instance keeps only a digest of the
  token, and every read is written to the audit log under a channel of its own.
- 039e65c: Add four layout blocks to the association's website: a banner, columns, a
  button, and a picture beside text.

  - **Banner**: a large picture with a heading, an optional short text and an
    optional button. The words stand on the theme's surface under the picture,
    so their contrast does not depend on the photograph.
  - **Columns**: two or three columns side by side, one under the other on a
    narrow screen. A column holds paragraphs, headings, pictures and buttons, and
    never columns or another layout block.
  - **Button**: a call to action leading to one of the association's pages, the
    news, the calendar or the broker information page, or an https address, in a
    prominent or a subtle style. A button to a page a reader may not open - a
    draft, a page for the members, a deleted page - is not shown to that reader.
  - **Picture beside text**: a picture on the left or the right of the board's
    own text, above it on a telephone.

  A banner's picture and a picture beside text must be described. Every picture
  in a banner, beside text or inside a column is checked for a public file and a
  confirmed publication consent like a picture block, and every word and address
  on them is scanned for personal identity numbers. The page editor offers all
  four with fields that work from the keyboard and with a screen reader. Stored
  pages are unchanged.

- e4cf311: Give a page on the association's website one status, let the board choose the
  front page, and make a page's address from its title.

  A page is now a draft, members only or public, chosen in one place in the page
  editor and written when the page is saved. It replaces the published flag and
  the visibility beside it. The upgrade keeps who can read every page: a published
  public page is public, a published members' page is members only, and an
  unpublished page is a draft. When it was first published is kept.

  The front page is chosen with "Use as front page" on a public page, and
  arranging the menu no longer changes it. There is one front page at a time, and
  choosing another replaces it. The front page cannot be made a draft, made
  members only or deleted until another page is chosen. The upgrade chooses the
  page the website's address served the day before, so an upgraded site looks the
  same. An instance with no public page has no front page, and its address
  answers as it did.

  A new page needs only a title. Its address is made from the title, with å, ä
  and ö read as a, a and o and a number added when another page has it, and moves
  with the title until the page is first published. The address can be written by
  hand under "Advanced" in the page editor. Every page that exists when you
  upgrade keeps its address.

  For API clients: `POST /api/site/pages/:id/publish` and `/visibility` are
  replaced by `/status` (`{ "status": "DRAFT" | "MEMBERS_ONLY" | "PUBLIC" }`), and
  `/front-page` chooses the front page. A page carries `status`, `frontPage` and
  `slugFollowsTitle` in place of `published` and `visibility`, and `slug` is
  optional when a page is created or saved. The actions `page_set_status` and
  `page_set_front_page` are new; `page_publish` and `page_set_visibility` are
  deprecated aliases of `page_set_status`, which refuses their old input with the
  schema it takes instead. `page_create` still accepts `visibility`, deprecated
  and ignored, and makes a draft. ADR 0027 records the model.

- 4ced8ff: Add pending changes: a call to an action held as a preview until the person it
  was proposed as confirms or rejects it on a screen of the platform's own, at
  `/app/pending-changes`. A plugin proposes one with `host.actions.propose`, which
  checks the call as `invoke` would and runs nothing; confirming runs it as the
  person confirming, with what they may do at that moment, and every check made
  again, including the arming of a plugin's action proposed through a connected
  app. A change is claimed before its action runs, so it never runs twice. Only the
  proposer can see or act on a change, and it lapses after a week.
  A write on the `ai` channel is refused with `confirmation-required` and has to be
  proposed. Proposing, confirming, rejecting and expiry are each recorded in the
  audit log, and the entry of the action the change held names the pending change;
  a write that action makes through `host.actions.invoke` is the plugin's own and
  does not. See ADR 0039.
- a050e5b: A plugin can now serve a screen in the stairwell, or any other device nobody
  signs in to, without borrowing a person's session and without a public route
  (ADR 0031).

  A manifest declares `deviceRoutes`: paths under the plugin's own mount that
  answer `GET` and `HEAD` to a device token and to nothing else. The plugin issues
  a token through `host.devices`, only on a request from a board member who manages
  the website, and the token reaches that one route of that one plugin. It is
  stored as a digest, rate limited, and revoked at once from the plugin or from the
  new Devices screen, where the board sees every live token on the instance and
  when it was last used. A plugin with a device route may not read the address
  book or the finances. `@Public()` on a plugin route still has no effect.

  Device routes, and every path the board consented to as one that a later
  version dropped or moved, are the only place the API sends CORS headers, so a
  player packaged as a TV app can read them, the refusal that says its token is
  gone included.
  `OPENBRF_DEVICE_TOKEN_CALLS_PER_MINUTE` (default 120) bounds what one device may
  spend.

  The catalog index gains version 2, which adds `deviceRoutes` to a plugin entry.
  This instance reads versions 1 and 2. A version that adds or moves a device
  route is held as `device-routes-widened` until the board consents again, and
  one that drops a route revokes the tokens issued for it.

- 4135ce7: A plugin can now read the association's fee notices and charges, record where
  it delivered one, and hear when one is issued or changed, through
  `host.finances`. This is the free part of advanced finances: what carries a
  notice or a charge into an accounting system or a bankgiro file is a plugin's
  own work, and it now has a public API to do it on.

  - Reading the finances covers the fee notification runs and their notices and the
    charges to members, masked as the files the board hands over and further: a
    person with protected personal data, or whose processing is restricted, is
    never named to a plugin, and a withheld value is a `withheld` branch rather
    than an empty string. The board's reason for a charge is withheld wherever
    such a person lived in the household charged on the day of the charge. No
    read carries a personal identity number or any payment state.
  - A separate permission lets a plugin record a delivery receipt - the route, the time
    and the receiving system's reference - against a notice or a charge. It is
    never a paid flag, it is audited, and the board sees receipts beside each
    notice on screen; they are not printed and not in the file. A plugin's read
    withholds a receipt's reference wherever the row's names are withheld, and
    on every receipt another plugin recorded. The data subject access report
    lists a notice's or a charge's receipts beside it.
  - `host.finances.events` delivers `feeNotification.issued` and
    `memberCharge.recorded`, `corrected` and `removed`, versioned per type and
    enqueued in the same transaction as the act. An event queued when the board
    switches the plugin off is dropped, not retried.

  A plugin route reading the finances or recording deliveries requires both the
  fee and the member charge management rights. The plugin consent screen names
  the two permissions and the financial personal-data category a plugin reading
  charges declares. A manifest
  may not ask to read the finances beside publishing website blocks, as it may not
  ask for the address book there: a notice names the people it is for, and a
  website block is published to anybody. `host.finances` is feature-detected; the
  contract version stays 1. `docs/plugin-contract.md` now also says plainly that a
  plugin setting is no place for a credential.

- 1504a5a: A plugin can now say in its manifest that it handles free text, charges,
  photographs and the other personal-data categories the association's record
  of processing activities uses, not only names, apartments, residency, email and phone.

  A plugin that calls actions handles whatever those actions return. An assistant
  that passes issue reports and minutes to a model provider handles what people
  wrote, and its manifest could not say so before. The install consent screen and
  the record of processing activities written at install therefore said less than
  the plugin handled. Both now show the new categories, in Swedish and in English.

  `personalData` in a manifest and in a catalog entry takes `postalAddress`,
  `account`, `financial`, `health`, `photograph`, `freeText` and `auditTrail`, as
  well as the five it took before. `personalIdentityNumber` and `protected` are
  refused: no plugin is ever given a personal identity number or a person with
  protected personal data. The catalog index stays at version 1. An instance
  older than this one refuses the whole catalog index if one entry names a new
  category.

- a161792: Let plugins add blocks to the association's website. A plugin declares its
  blocks in the manifest's new `blocks` field - a name, a label, an icon, a
  category and the settings the board fills in - and registers a render function
  for each with `host.blocks.register`. Declaring a block asks for the new
  `site:blocks` permission, which the install consent screen shows; a plugin may
  not ask for it beside `addressBook:read` or `addressBook:readContact`.

  The page editor offers a serving plugin's blocks beside the core's and draws
  their settings form from the declaration, and a save is held to it. A block
  the page already holds is never left out of a save: if a new version of its
  plugin asks for a setting the block does not hold, the editor names the block
  and saves nothing until the board answers it or removes the block. The
  website renders each block on the server through its plugin and prints only a
  short list of elements and attributes from the answer: no script, style, event
  handler, picture or frame reaches the page, and a link is held to the same
  schemes as a link in a paragraph. A block whose render throws, takes longer
  than two seconds, or renders something shaped like a personal identity number,
  in its text or in any attribute it keeps, is left off the page and logged, and
  the rest of the page renders. A block of a plugin that is switched off or
  removed stays on the page as stored and shows nothing. A new plugin finding, `block-refused`, reports a plugin that
  registers a block its manifest does not declare.

- 0b81f93: An administrator can now open support access from the settings, so that
  whoever hosts the instance can send somebody to help (ADR 0028). The
  administrator chooses how long it stays open, from one hour to seven days, and
  gives a reason, which is kept in the audit log for good. Any administrator can
  close it at once. It also ends at its end time, or when whoever opened it is no
  longer an administrator.

  While it is open, the host asks the management API for a sign-in link with the
  new `POST /v1/support-sessions`. The link works once, for ten minutes. The
  supporter is never added to the register and gets no account. Their session is
  read-only and lasts at most eight hours, every screen says who they are and
  when the access ends, and no screen offers them a control that would change
  anything. They see what the administrator uses to run the instance,
  and never a personal identity number, a lien, a protected person's details, the
  association's casework or an apartment binder. Every request they make is in
  the audit log on a new `SUPPORT` channel, against the administrator who opened
  the access, and the settings screen lists each supporter and when they were
  signed in.

- df37052: Edit the association's website pages as they look. The page editor now has an
  address of its own (`/app/admin/site/pages/<id>`) and draws the page with the
  website's own markup and stylesheet, in the active theme, so what the board
  writes is laid out the way a visitor will read it.

  - **Write where the words stand.** The title, paragraphs, headings, captions,
    a banner's heading and text, a button's label and the questions and answers
    are edited in place on the page.
  - **Add with +.** A + at the end of the page, in each empty column and in the
    tools of every block opens a list of the blocks that may stand there, by
    category, with a search.
  - **Settings beside the page.** A selected block shows its settings in a side
    panel - its picture and description, where a button leads, a heading's rank,
    the number of columns - next to the page's own: who can read it, Use as
    front page, and its address under Advanced.
  - **Arrange by dragging or from the keyboard.** A block is dragged by its
    handle, into and out of columns. The same handle picks it up with Enter or
    Space, the arrow keys move it through every place it could be dropped, and
    each step is announced to a screen reader; Move up and Move down stay.
  - **Duplicate and remove with Undo.** The last changes to the arrangement can
    be taken back without touching the words written since.
  - **Leaving with changes not saved is asked about**, inside the application
    and when the browser tab is closed.

  The separate preview is gone: the page is its own preview. The website's
  layout stylesheet moved from the API to `@openbrf/shared` so the editor and the
  website read one copy, and a button is styled by its class rather than as a
  link, which changes nothing a visitor sees. Stored pages are unchanged.

### Patch Changes

- 63a95f4: A plugin that dispatches an action can now tell why the call was refused. The
  SDK exports the registry's refusal vocabulary, `ACTION_ERROR_REASONS`, and
  `ACTION_ERROR_MCP`, the table that says whether a connector renders each refusal
  as a protocol error or as a tool result and whether trying again could work. The
  API now reads both from the SDK, so the catalogue endpoint and a plugin read the
  same list.

  `host.actions.invoke` now rejects a refused call with an `ActionRefusal`, one
  shape for the registry's own refusals, an input the action's schema refuses and
  a refusal from the service behind the action, and `isActionRefusal` recognises
  one. It carries the reason, the status, how to render it, the retry verdict and
  the particulars, and for a token missing a scope the bearer challenge a
  connector sends back so the client can ask for that scope. Before this a plugin
  received the host's own error classes, which it cannot import. A plugin route
  that rethrows the refusal answers with the status and headers the registry would
  have, and an invalid body is now answered with a 400 there rather than as the
  plugin's failure.

- 0cde00c: A plugin can no longer act for a person on a request it kept past its response.
  The host's mark on an authenticated request now ends when the response is sent
  or its connection closes, a request whose connection closed while it was still
  being authenticated is never marked, and `host.actions.invoke` and `host.actions.list`
  refuse a request whose response has ended, as does a caller handle minted from
  it. Before this a plugin could keep a board member's request and pass it again
  from a job or while serving somebody else, and the action and its audit entry
  named the board member as the one who acted.
- 4018271: The broker information page (`/maklarinfo`) now says when the board last
  confirmed its facts: "The board last confirmed these facts on 14 March 2026."
  It appears under the title once at least one fact is recorded.

  Saving the facts confirms them. On the facts screen the board can also confirm
  them without changing anything, with "Confirm the facts still hold". That
  is refused (409 `nothing-recorded`) while no fact is recorded, including after
  the board has cleared every fact. A connected app cannot: an `association_facts_update` call that changes no fact
  is recorded but moves no date and confirms nothing. The
  screen shows the date beside that button. Each confirmation is written to the
  audit log as `ASSOCIATION_FACTS_CONFIRMED`, with the date it replaced; a save
  is recorded as before.

  The board also sets how many months the facts count as current after a
  confirmation: from 1 to 12, and 3 unless it changes it. The setting has its own
  field and its own save on the facts screen
  (`PUT /api/site/facts/stale-after-months`, `site:manage`). Changing it confirms
  nothing and leaves both dates alone. Each change is written to the audit log as
  `ASSOCIATION_FACTS_STALE_AFTER_CHANGED`, with the old and the new number.

  On upgrade, an association that has already recorded facts gets the date of
  its last save as its confirmation date, and 3 months. No operator step is
  needed. The `association_facts_get` action now also returns `confirmedAt` and
  `staleAfterMonths`.

- 1358fa3: A plugin that declares a device route or a website block is now kept away from
  every permission that reads the register, including one added later: each
  permission is classified as reading it or not, and both rules follow the
  classification instead of a list of the refused.

  When a package is skipped because a device route or a website block sits beside
  a permission that reads the register, or because a device route overlaps the
  OAuth protected resource, the admin screen now words the reason in Swedish
  instead of showing the schema's English line.

- a84a409: Move the general meetings from the board's section of the navigation
  to the association's, and show the motions indented
  directly under it, in the band's panel and in the phone's menu sheet. A member
  who is offered the motions but not the meeting keeps them at the section's own
  level. The routes, the capabilities that gate each destination and the phone
  bar's slots are unchanged.
- dc96235: Publish the 1.0 free/paid boundary in GOVERNANCE.md and ROADMAP.md.

  The board decided the boundary on 2026-10-19. A module is paid only if it is
  (a) a service Apteo runs, (b) a contract or account Apteo holds with a third
  party, (c) design work sold as an optional theme, or (d) a module Apteo
  licenses per instance that is named in a closed list in ROADMAP.md. Adding to
  that list needs a board decision and is announced here. Statutory duties,
  security controls (sign-in, access control, the audit log, backup and restore)
  and data exports are never paid, and a core feature is never moved into a paid
  module.

  This removes "per-instance licensing" as a reason of its own and supersedes the
  "delivery into another system" test in ADR 0011. What changes on the roadmap:

  - The licensed modules are the MCP Connector, autogiro and bankgiro files, the
    approval step before a charge leaves, and parking space sharing.
  - Every other paid module states its reason. Recurring address book import,
    digital signage, advanced finances and the advanced booking, broker and
    property manager packages are split, so the free part of each is named.
  - Maintenance planning is free. Fee notice sending, the display mode for
    screens and re-running an address book import with a diff to review are on the
    roadmap as free.
  - Reporting to Lantmäteriet, the transmission included, is never paid.

  No code changes, and nothing that is free today becomes paid.

- 82b3ed5: Signing in now lands on an overview at `/app` ("Overview"). Everybody who lives
  in the house sees what they have sent in and are still waiting on - open
  issues, and motions, subletting applications and key orders the board has not
  answered - with each one's status and a link, their upcoming bookings, the next
  events and the three newest news items. Whoever works a queue also gets "To
  handle": one row per queue their account holds, with how many items are
  waiting and a link to it - new issues, unanswered threads in the board mailbox,
  motions not yet received, subletting applications and key orders to answer,
  account requests and reported posts. A panel whose read fails says so
  on its own; the rest of the page still shows.

  The address book has moved to `/app/address-book`, and its entry in the
  navigation is now in the board's section and offered on the board's view of it. A
  resident still reaches the resident directory at that address, but the menu no
  longer carries a link to it for them. The phone bar's first column is the
  overview, for the board and for residents; residents' bar no longer holds
  "News", whose newest items are on the overview.

- 2fe1bcb: Declare each website block type once. A block type's stored shape, strict
  schema, reading, the text the publication guardrails scan and how the page
  editor offers it are now one definition in `@openbrf/shared`, read by the API
  and the editor alike, and the website's renderer is keyed by the same types.
  Every existing block reads, saves and renders as before, and stored pages are
  unchanged.

  A block whose type is namespaced as a plugin's, `<plugin id>/<name>`, and that
  no installed plugin defines now shows nothing on the website and is kept when
  the page is saved, instead of being dropped. The page editor shows it as a
  plugin's block that can be moved or removed. Its text is scanned for personal
  identity numbers before the page is published. Such a block is limited to
  10 000 characters of JSON and 32 levels of nesting; one over either is refused
  when the page is saved. The page actions show it but do not accept it back.

- 6d05800: A plugin's controller can now raise a route above its capability floor with
  `RequireCapability`, exported from `@openbrf/plugin-sdk` with the metadata key
  it writes (`REQUIRED_CAPABILITIES_KEY`) and the capability names a route may
  require (`PLUGIN_ROUTE_CAPABILITIES`, `PluginRouteCapability`). Before this a
  plugin had to set the key itself with `SetMetadata`. The API's own decorator is
  the same one, so the two cannot disagree on the key.
- 87f92ee: A member list can now be imported again whenever a newer file arrives. A file
  is recognised by its column titles: the mapping the board last started an
  import from such a file with is offered in place of the guess, and a file that
  holds exactly the rows imported last is answered with "nothing new in this
  file" instead of a preview, with a button to review it anyway. A file the
  register did not take whole, because rows had problems or the import stopped,
  is always reviewed. What is kept for such a file names nobody: a keyed digest
  of its column titles, the mapping, and a keyed digest of the rows last
  imported. It is deleted once no import has used it for two years.

  The preview of a file imported again tells the rows the register already agrees
  with ("No change") apart from the updates that change it, and says what each of
  those adds: an email address, a phone number, a postal address or a residency.
  Below the rows it lists the residencies the register holds today that no row of
  the file reaches. That list is for reading only: the import never ends a
  residency, because a file that leaves somebody out does not say they have
  moved.

  A preview planned before this version, in a session uploaded within the last
  day, is reported as outdated and taken again.

- e5499c6: Keep the schema owner's and the runtime role's passwords out of the database's
  log. The deploy steps used to send each password inside the `ALTER ROLE`
  statement that sets it. PostgreSQL logs a failed statement in full, and logs
  every statement on a server set to `log_statement = ddl`, so the password could
  end up in the `db` container's log. The steps now work out the password's
  SCRAM-SHA-256 verifier themselves, as psql's `\password` does, and send that
  instead. PostgreSQL stores a verifier as it is given, so signing in does not
  change. That includes a password you supply with characters SASLprep changes,
  such as a ligature or a non-breaking space: the steps prepare it with SASLprep
  exactly as PostgreSQL does before they hash it.

  docs/deployment.md, "On a platform that shares every variable", now has an
  instance that set its passwords as variables give its superuser a new password.
  Until now it kept the old one, which the platform had handed to every service.
  The docs no longer have it keep `POSTGRES_PASSWORD` for one deploy either: on
  such a platform both the database and the application refuse that variable.

## 0.2.0

### Minor Changes

- 21a3b1c: Run the production stack on a platform that gives every service every
  variable, such as Coolify, by generating the database passwords instead of
  asking for them.

  `docker-compose.prod.yml` asks for no database password any more. A new
  `superuser-password` service puts the database superuser's password in place
  before the database starts, generating one on a first boot and on no other;
  `schema-owner` generates the schema owner's, and `migrate` the runtime role's.
  Each is kept on a volume that only the services using it mount, so the
  application's container never holds the superuser's or the owner's password,
  whatever a platform hands it. On Coolify 0.1.0 crash-looped on exactly that:
  every variable reached the application, which refused to start holding them.

  An instance that sets `POSTGRES_PASSWORD`, `OWNER_DB_PASSWORD` and
  `RUNTIME_DB_PASSWORD` keeps working unchanged: a variable that is set wins, and
  the first `up` writes `POSTGRES_PASSWORD` onto the superuser's volume, after
  which all three can be emptied. docs/deployment.md, "The database passwords",
  covers this, a lost superuser password, and "On a platform that shares every
  variable" what to set there.

  **Act on this when upgrading:** the application no longer publishes a port on
  the host. A reverse proxy on the stack's network reaches it as `app:3000`; one
  on the host itself adds the new release asset `docker-compose.host-port.yml` to
  every `up`, which publishes it at `APP_BIND_ADDRESS` and `APP_PORT` as before.

  A `BETTER_AUTH_SECRET` with whitespace in it is refused at start in
  production. That includes the compose file's own message for a missing value,
  which Coolify fills the variable in with and which the earlier checks let
  through.

## 0.1.0

### Minor Changes

- 87bcb63: Put everything the association keeps against a person on their data subject
  access report.

  The report states the sessions a person's account is signed in with - when each
  began, when it was last renewed, when it ends, and the IP address and browser it
  came from - the passkeys on the account, the invitations to an account they were
  sent, and every news mailing, SMS mailing and notice of a general meeting
  addressed to them, with whether it went out and, where it did not, why. None of
  it carries a token, a password hash or anything else that opens the account.

  The printed report shows the charges, fee rates and fee notices the report
  already held.

  A test fails for any column in the database that names a person unless the
  report reads it or the reason it does not is written down, and four such
  reasons are open questions named in ADR 0019.

  A signed-in session is deleted the night after it ends, unless a legal hold or a
  restriction stands for the person, and the purge deletes every invitation to an
  account with the account, accepted or not. The record of processing activities
  says so, names former residents and everybody an invitation or a general meeting
  can reach on the rows these belong to, and no longer says that the board deletes
  decided sign-up requests, which nothing does.

- df165a8: The audit log now records which way each change reached the association's
  records, and the data subject access report prints it.

  Until now the log answered who did what, and could not say how they reached the
  records. That was enough while a person in a browser was the only way in. The
  column names one of five routes on every entry written from now on: the web
  interface, a connected app acting as the person who connected it, the AI
  package, the association's own nightly jobs, or a plugin. Where a connected app
  acted, the entry also names which app.

  Entries written before the column existed carry no channel, and cannot be given
  one: the log is append-only, which is what makes it evidence. The data subject
  access report says so in words rather than leaving the cell blank, because a
  blank cell on a statutory document reads as though nothing happened.

  The report also names sixteen acts it could not name before. Twelve of them the
  log had been recording all along and the document printed as an empty cell -
  charges entered and corrected, the debiting list exported, the board mailbox
  worked, a transfer reversed, how the association holds its land. Those cells now
  carry a sentence in the association's own words, and an act added to the log in
  future cannot reach the report unnamed.

  Every edit of the website's menu is now recorded, the board's own edits
  included. The menu decides what is offered rather than what may be read, which
  is why it went unrecorded; it is also the one place on a public page where an
  address leaving the instance can be planted, so the entry names where an
  external entry points.

- d4d763d: Do the rest of what a controller has to do: the record of processing
  activities, the breach register, processor agreements, the privacy notice
  measured against art. 13, and the requests a person makes about their own data.

  The hard half of data protection was already here - encryption at rest, access
  control, masking, the audit log, retention with a nightly purge, the data
  subject access report. What was missing was the half a supervisory authority
  asks to see: the records. A board could run this platform lawfully and have
  nothing written down to show for it. This is the writing down, and it is in
  Core and free, because what an association must do to process personal data
  lawfully is part of the product rather than something to pay for.

  **The record of processing activities (art. 30) is seeded, not typed in.** A
  board cannot be expected to enumerate its own processings from memory, and a
  register somebody typed once goes stale the day a setting changes. So the
  instance writes down what it already knows it does - the statutory registers,
  the address book, the mailings, the issue queue, the document archive, the
  bookings, the events, the meetings, sixteen processings in all - each with its
  purpose, its legal basis, the categories of personal data and of people, the
  recipients, the retention and the security measures. Every one of them is
  editable and the board can add its own, because an association processes things
  outside the application too. The controller's contact details, the joint
  controller where there is one, and the data protection officer where the
  association has appointed one are recorded once and read from there.

  **The breach register runs a clock rather than holding a form.** GDPR art. 33
  starts counting from the moment the board became aware of a breach, which is
  not the moment somebody sat down to write it up, so those two dates are
  separate columns and the deadline is derived from the first. The board is
  mailed when a day of the 72 hours is left. Recording a breach is one act;
  deciding it is another, and the decision carries its ground: IMY is notified,
  or it is not because the breach is unlikely to result in a risk to the people
  concerned (art. 33(1)); the people affected are told (art. 34(1)), or they are
  not under one of the exceptions in art. 34(3). A record whose notification went
  out after 72 hours will not close without the reasons for the delay art. 33(1)
  requires. The notification itself goes through IMY's own e-service - what
  belongs here is the record, the clock and the evidence of the decision.

  **A recipient is classified before an agreement is asked for.** Not everything
  that receives personal data is a processor, and asking a board to sign an
  art. 28 agreement with its own hard drive would teach it that these records are
  paperwork. So each recipient the instance actually has - read from the
  configuration rather than from a list somebody maintains - is classified first:
  a processor, no processor because it runs on the association's own
  infrastructure, or an independent controller. Only a processor needs an
  agreement, with the terms art. 28(3) requires and the prior authorisation of
  sub-processors art. 28(2) requires. The SMTP server, the SMS provider and the
  object storage are each there when they exist and absent when they do not; the
  local disk is listed with "no processor" already suggested; and hosting is
  listed because somebody runs the machine and only the board knows who. A plugin
  is a recipient too, and the consent step now asks the one question the instance
  cannot answer for itself: whether this plugin sends personal data outside the
  instance, and to whom.

  **The privacy notice is measured against art. 13 rather than assumed to
  satisfy it.** The seeded page grew from six headings to fifteen - the legal
  basis behind each purpose, the legitimate interest where that is the basis, the
  recipients, transfers to a third country, automated decisions with the logic
  involved and what they mean for the person, the data protection officer, the
  right to withdraw a consent, whether giving the data is a statutory or a
  contractual requirement and what follows from not giving it, and the right to
  complain to IMY. The screen names the headings the published page has not
  answered yet and can append the missing ones for the board to fill in, and the
  controller's contact details are a block the page reads from the instance
  rather than something retyped into prose that then goes stale.

  **A person can ask for more than a copy.** Erasure ahead of the retention
  window on one of the grounds in art. 17(1), granted only where none of the
  exceptions in art. 17(3) applies - which for a cooperative means no statutory
  duty to keep the record and no legal claim, the ground a legal hold already
  records. An objection to a processing (art. 21). A restriction of it
  (art. 18). Each is recorded against the person with the ground the board relied
  on, answered inside the month art. 12(3) allows - a due date derived from the
  calendar rather than stored - and each reaches the screens the processing
  actually runs from: an objection stops the news mail and the text message, a
  granted erasure brings the nightly purge forward to the next run, and a
  restriction stops every purge from touching the person at all, because art.
  18(2) says the association may store the data, which makes erasing it the one
  act the person asked it not to perform.

  **Data portability (art. 20) hands the person a file.** A machine-readable
  export of what they gave the association under the membership contract or under
  their consent, and nothing else: no statutory register content, no audit trail,
  no personal identity number, no legal holds. It is separate from the data
  subject access report, which is a printed document by design and stays one. The
  export says in words that it is handed to the person to transmit themselves,
  because a direct transfer to another controller under art. 20(2) is required
  only where technically feasible and no receiving standard exists between
  housing cooperative platforms.

  **The nightly purge reaches issues and the document archive.** Both are service
  tier and both were listed on the access report without ever being erased. An
  issue or a document is detached from the person rather than deleted: the link
  and the personal data on the row go, the record stays. The description is not
  rewritten - it is free text the reporter wrote about the building, it is the
  record of the problem, and a job editing prose on a schedule would be the
  association quietly editing its own history. A report filed through the public
  form is keyed to nobody, so no person's clock would ever reach it; it is
  detached on a clock of its own, a year after the board closed it.

  **One screen, and a strip at the top of it that answers "do we owe anybody
  anything today".** Four sentences rather than four numbers, each reading as a
  word when it is zero, because a board that has nothing waiting should be told
  so - an empty strip looks like a screen that has not finished loading.

  Everything here is service tier and inside the retention policy, except the
  audit entries, which are outside every purge as they have always been. The
  statutory registers are untouched.

- edc9eb1: Record what a person has agreed may be published, and widen the audit log to
  cover the acts that decide access.

  Publication consent (publiceringssamtycke) is now a record the board keeps, on
  the person view beside the protected personal data flag. It covers one scope at
  a time - a photograph, a name on the website, the published board roster -
  because agreeing to be named is not agreeing to be photographed. Granting and
  withdrawing are dated facts rather than a switch: a withdrawal closes the
  consent with a date and leaves the row on file, so the period a consent covered
  stays readable, and that period is what says a page published while it stood was
  published lawfully. A person who agrees again is recorded again, beside the
  earlier consent rather than over it. Every change writes an audit entry in the
  same transaction, and a change that changes nothing writes neither an entry nor
  a date. The field is the board's, on the board's own person view: the
  resident-facing directory has no person view at all.

  The audit log gains the vocabulary for the acts that decide who reaches the
  association's data. An invitation now records both halves - the board issuing
  the link and the recipient using it - and a self-signup decision records the
  approval or the rejection, each in the same transaction as the decision itself,
  so a board member who loses the race to decide a request writes nothing. A theme
  written on the instance is recorded as composed as well as installed, which is
  the difference between tokens authored here and a package downloaded from a
  catalog.

  The personal identity number's parse, canonical form and checksum move into the
  shared package, unchanged byte for byte, and gain a scanner that finds one in
  free text. The scanner is what lets a personnummer be refused at the keyboard
  rather than after a page is live: candidates are matched by shape and then put
  through the same validator a stored value goes through, so the calendar and the
  checksum are what decide. An organisation number is left alone - a housing
  cooperative prints its own in its footer, and the third digit pair of one is
  never a month.

- 3a515aa: Correct the registers, fees, charges, key orders, subletting and the member
  import where they could record or report the wrong thing.

  **Operators:** after upgrading an instance that recorded moves or ran a member
  import before this release, run `openbrf member-register reconcile` once, read
  its report, and then run it with `--apply`. It appends the member register rows
  that an older register is missing and changes nothing else. See
  `docs/member-register-reconciliation.md`.

  Registers and moves:

  - A transfer or a grant is recorded only for a tenant-owner, on both sides of
    the move, and an apartment is granted once.
  - The initial supply to Lantmäteriet leaves out the holders of an apartment
    whose tenant-ownership has been terminated, takes the membership decision
    from the transfer that began the current holding, and lists apartments in a
    fixed order, as the apartment register extract now does too.
  - The member register extract no longer lists an apartment against a
    membership that began on the day the apartment was left.
  - Removing an address that gains an apartment at the same moment answers with
    the refusal rather than a server error.

  Fees:

  - A fee rate cannot be recorded from a day a notification run has already
    billed, and a rate that no run billed can be removed even when a run's period
    covers its days.
  - A run is refused, rather than failing, when a notice would exceed what an
    amount can hold, when its payment references would repeat a run's from a
    century apart, or when its period is older than notices are kept for.
  - A protected person living in an apartment withholds the household's names on
    the fee notice, whether or not they hold the tenant-ownership.
  - Closing a fee rate stamps the financial year it ends in.

  Charges, key orders and subletting:

  - A correction that sends the VAT treatment again keeps the stored rate.
  - A charge cannot be dated before the seven years charges are kept for.
  - The debiting list export's audit entry records how many rows it held.
  - A key order or a sublet application can no longer be revised once the
    applicant has moved out of the apartment.
  - A sublet period may end at most five years ahead.
  - Every nightly purge runs at a minute of its own.

  Member import:

  - The preview names each row by its row in the uploaded sheet.
  - The upload's sample rows hide personal identity numbers.
  - A ten-digit identity number gets its century from the whole birth date.
  - Whether a residency has ended is judged on the association's calendar day.
  - A quoted CSV field after a space, and a header title with a line break in
    it, are read correctly.

  Every CSV file the platform writes also quotes a cell holding a comma or a tab.

- 2b229e0: Put the association's calendar on its public website: a page at /kalender, an
  address per event, and a block the board can put on a page it writes.

  The calendar is read a month at a time, and the way between months is two
  anchors. A month is a query parameter, previous and next are ordinary links, and
  the reader's own back button works - the website's content policy names no script
  source at all, so a calendar that needed one would not run in a browser, and one
  that needs none can be read with JavaScript switched off, in a text browser, and
  from the address printed on a notice. Which month somebody is looking at lives in
  the address bar, because the website sets no cookie and keeps no session. The
  parameter is read strictly and clamped: a value that is not a month leaves the
  reader on the current one, and a month outside the year back and two years
  forward the calendar reaches is pulled to the nearest edge rather than refused -
  there is nothing there a visitor could have got wrong. At either edge no anchor
  is printed, because a link that answered with the month it was followed from
  would read as a fault.

  A month boundary is a wall-clock fact, like every other time in the calendar. A
  midsummer party starting at half past midnight on the 21st of June is 22:30 UTC
  on the 20th, so a month window worked out in UTC would file it under the month
  before for part of the year. The window is derived from the same conversion the
  dates themselves were written with, and it is asserted in both directions: the
  date is in the month it falls in and absent from the one before it.

  Which dates a reader is answered with rests on one thing, whether the request
  carried a session, exactly as it does for a page and a news item. There is no
  capability read on the public website and there cannot be. An event the board
  published to the street is on the calendar for everybody; one published to the
  members is on it for anybody signed in; a draft is on it for nobody. Asked for by
  its own address, an event that is not the reader's to see is answered with the
  website's own not-found document - byte for byte the same one an address naming
  nothing produces, and the same one the page routes send - so somebody holding a
  list of identifiers cannot tell an event that exists and is closed to them from
  one that does not exist. That is a property of the service returning a single
  null for all three cases rather than of the controller remembering to be careful.

  How many places are gone stands beside a date. Who has taken them never does,
  and that is enforced by the shape of the query rather than by what the renderer
  prints: the places are read as a filtered relation count, so the only thing the
  website can learn about a sign-up is how many of them there are, and no shape it
  is handed has anywhere to put a name. A withdrawal does not hold a place and is
  not counted. A date the board has called off says so - on the calendar page, on
  the event's own page and in a block on a page the board wrote, from one renderer,
  because a cancelled cleaning day shown as going ahead sends somebody down to the
  courtyard on a Saturday morning.

  The board puts the calendar on a page from the page editor and chooses how many
  dates it shows. The block carries no dates and no names, only that number: what
  it becomes is read when the page is rendered, against whoever is reading it, so
  one stored page shows a visitor with no account the events published to everyone
  and a member the members' ones as well. A page of an instance whose calendar
  holds nothing that reader may see renders no calendar at all rather than an empty
  heading - a page must not announce a calendar the association has not started
  keeping, and an empty heading is also how a visitor would learn that the members
  have dates they do not.

  The calendar is also offered as a menu destination, so a board arranges the entry
  that leads to it the way it arranges the news one, and both /kalender and
  /calendar are refused as page addresses: a page written at either would never be
  reached, and the board is told so while it is naming the page rather than
  afterwards.

### Patch Changes

- f408d9d: The address book's search field now stops at the 200 characters the search accepts. A longer search was refused, and the address book then showed its failed state without the search field, so the only way out was to reload the page. The limit is shared as `MAX_ADDRESS_BOOK_SEARCH_LENGTH` in `@openbrf/shared`.
- f408d9d: An apartment number ending in "00", such as "1000", no longer has a floor read out of it. No apartment on a landing is number zero, so the number does not follow the Lantmäteriet convention, and it is now stored with no floor instead of being listed under the entrance floor. The correction applies to apartments added from now on: a row written earlier keeps the floor it was stored with, and the board can remove an unused one and add it again to have it recorded without one.
- a1eaf25: Every date the association states is now read on the association's own calendar.

  Sweden runs an hour ahead of UTC in winter and two in summer, and Open BRF was
  reading the day off the clock in Greenwich. For that hour or two after midnight,
  every date produced from a moment named the day before: a register extract taken
  at half past midnight on the 6th of March was stamped the 5th, on a document
  handed to a member or an authority.

  The statutory extract of the member register, the statutory extract of the
  apartment register, the access report a person is entitled to under GDPR
  art. 15 and the address book export are all stamped with the day they were
  produced here. So are the dates a data subject request was decided, executed and
  closed, on the board's own queue and on the report alike, and the days a
  publication consent was given and withdrawn - a consent withdrawn at twenty to
  eleven on a summer evening was recorded as withdrawn the day before.

  On screen, an issue report, a motion, a comment, a contact message, a sign-up
  request, a key order, a sublet application and a news item all show the day they
  actually happened here. So does the discovery date of a personal data breach,
  which is the date the 72 hours of art. 33 are counted from, and the board seat
  panel no longer offers to end a term that has already ended. The charges screen
  read the reader's own clock, so a board member abroad was offered a charge date
  the association then refused, and on the 1st of January the wrong year; it reads
  the association's day now.

  Dates that were already days - a move-in, a meeting, a period - are unchanged.
  Those carry no time and no zone, and reading one in a zone would be a new way of
  getting it wrong.

- dbc309d: Keep the board's note on a publication consent out of the audit log, which
  outlives every erasure. The entry now records only that a note was written. A
  note carrying a personal identity number is refused with the reason
  `personal-identity-number`, however it is written: soft hyphens, zero-width
  characters and fullwidth digits no longer hide one. A note sent with a
  withdrawal is refused rather than accepted and dropped. Consent notes in audit
  entries written before this change stay where they are.

  Every personal identity number check now also sees a number hidden with an
  invisible character (a byte order mark, a word joiner, a variation selector) or
  written in fullwidth digits, and a line break or tab inside free text is no
  longer removed before the check. A number written with spaces or a line break
  between its date and its last four digits (`811228 - 9874`, `811228 9874`) is
  found too, as the identity-number parser already read it. The note is stored as
  it was checked, with the invisible characters removed and fullwidth forms
  folded.

- f408d9d: The data-subject request forms and the breach decision and notification forms no longer answer a refused field with "could not be saved just now": they name the field the server did not accept, and they no longer send a request without its date or ground, or a decision without its ground. The grounds are held to the lengths the server accepts. A breach that was closed or removed in the meantime, or a notification recorded before the decision, now says so instead of falling back to "could not be saved".
- 53f44cf: Judge a ten-digit personal identity number's century by the whole birth date,
  store it with that century, and reindex the people already stored.

  A number written without its century takes the most recent birth date that is
  not in the future. Only the year was compared, so in March 2026 `261201-1235`
  was read as 1 December 2026, a date still to come, and a search for
  `192612011235` did not find the person. The date is now compared whole, with a
  coordination number's day taken without its offset of 60. A plus separator is
  still read as the year the person turns 100.

  Even read by the whole date, the same ten digits name another person once the
  day they are read on passes the birthday they carry: `261201-1235` is 1926 until
  1 December 2026 and 2026 from then on. So a number is now stored with the
  century it was read with (`19261201-1235`), and one whose reading would differ
  a year earlier or a year later is refused, by the person form and by the
  import, until it is written with its century. A number accepted on two dates
  less than a year apart is read as the same person on both, and an import whose
  rows would now be read differently from its preview is refused as outdated
  rather than applied.

  Each person now records the normalisation rules their blind indexes were
  computed under. After the upgrade the instance recomputes the indexes of every
  person stored before it, from the encrypted values, in a job queued at start,
  and writes the century into each stored personal identity number that lacks
  one: the century it was written with, not the one it reads as on the day of
  the upgrade. A number is taken as written when the person was added, unless
  the index stored beside it shows it was added later; a later change to the
  person, such as marking them protected, does not move it. Until the job has
  finished, a search by phone number or personal identity number can miss a
  person stored before the upgrade.

  A few stored numbers cannot be settled from the record: a number whose
  birthday falls between the day it could first have been written and the
  person's last change, such as `261201-1235` for a person added in March 2026
  and changed in December, could be either century. The job reads such a number
  as written when the person was added, or, when its index shows it came later,
  keeps the century that index carries, and logs a warning naming the person.
  Look for warnings from `PersonReindexService` after the upgrade, and check the
  century of those people's numbers with them.

- 933e778: Find a personal identity number written with an en dash, an em dash, a minus
  sign or another Unicode hyphen between the date and the last four digits, as a
  word processor sets `811228 - 9874`. Only the scan of free text accepts them;
  the parser a stored number goes through is unchanged, so no blind index moves.
- 1898cd6: Find a personal identity number written with any dash.

  The scan that keeps an identity number off a page, a news item, a motion or a
  subletting application took the hyphen and a list of look-alike dashes as the
  sign before the last four digits. A number written with a dash missing from the
  list, such as the horizontal bar (`811228―9874`), the two-em dash or the
  Armenian hyphen, went through. NFKC does not fold those. The scan now takes
  every character Unicode classes as a dash, plus the minus sign, and still runs
  in linear time. The parser for a stored number is unchanged.

  The import's check for number-shaped values now uses the same Unicode rules.
  It used to read `\p{…}` as literal letters, so a value such as `811228p9874`
  counted as number-shaped, and a value split by a non-breaking space did not.

- a2b2ec0: Close two gaps left by the subletting follow-up.

  The personal identity number scan now reads the characters that look like the minus
  between the date and the last four as that sign: the modifier letter minus, the
  hyphen bullet, the heavy minus sign, the box drawings horizontals and the
  horizontal line extension. The scan did not recognize these look-alike signs, so
  a number written with one passed it. The parser for stored values is unchanged.

  Recording the end of a subletting answers "no such application" when the nightly
  purge deleted the application between the read and the write, instead of 500.

- 26c5236: The member list import writes each person once, and reads a file within fixed
  limits.

  - Only one import is written to the register at a time, and every part of an
    import is planned again under its locks before it is written.
    Coming back to the import screen shows the import that is still running
    rather than a newer one that has finished.
  - The preview is worked out in the background, and the screen shows how far it
    has got. A long file with personal identity numbers, checked against a
    register that already holds some, no longer keeps a request open for
    minutes. That includes the preview taken again with the board's decisions. A
    preview the screen stops waiting for - another file is chosen, or
    the page is left - is stopped at once, and one the screen stops asking about
    is stopped after two minutes, so neither holds up the next one.
  - The apply runs only the preview the screen was shown. If the upload has been
    previewed again since - in another tab, or by another board member - the apply
    is refused and the screen goes back to the column mapping.
  - A row for someone who already lives in the apartment in another role, or for
    other dates, is reported as a problem with the row instead of being dropped
    without a word. Someone who moved out and back in gets their second period.
  - A row that states its own move-in date is matched by apartment and name to
    someone whose residency there has ended, instead of creating them again.
  - An uploaded file is refused while it is being read once it passes 5000 rows,
    200 columns or 1000 characters in a cell, and a workbook once it unpacks to
    more than an import reads or names a cell it cannot place. Cells that are
    only formatted, below or beside the list, do not count. A quotation mark that
    is never closed is refused instead of turning the rest of the file into one
    cell.

- a41bd1c: The issue report's place and description limits (200 and 4000 characters) are
  now one definition in `@openbrf/shared`, used by both the API and the report
  form, so the form and the server cannot drift apart.
- 094f814: Harden sign-in, connected apps and the register after the access-control
  review:

  - One rule decides where an authorization code may be sent, shared by client
    registration and the consent screen: https off this machine, plain http on a
    loopback host, or an app's own reverse-domain scheme. A client that
    identifies itself by its metadata document must keep its web redirect
    addresses on that document's origin, and every address in the document
    must meet the shared rule. No name under `localhost` is taken for https.
  - The consent screen names the app when the code goes to an app's own scheme,
    and says that any app on the device can claim that name.
  - A connected app's token carries only the scopes the member's consent grants
    now.
  - In production, a `BETTER_AUTH_SECRET` committed to the repository or with
    fewer than 8 different characters stops the instance from starting, even
    when it is 32 characters long. Replace such a secret before updating, as the
    upgrade note on the 32-character rule describes.
  - A change sent with the session cookie in a body an HTML form can send
    (URL-encoded, multipart or plain text) is refused when it carries neither
    `Origin` nor `Sec-Fetch-Site`.
  - An invitation to an address another account already signs in with is
    refused with its own message instead of failing at activation.
  - An election may be dated at most five years back, also in a board
    recovery.
  - A failure's logged stack keeps only lines shaped like call frames.
  - Putting somebody into a group chat they are already in answers with the
    member list, whoever they are.
  - The confirmation of an account request says that a later request from an address with one
    waiting is not kept.

- f408d9d: Changing a password to one longer than the 128 characters signing in accepts now says the new password is too long, where before it said the current password did not match. The password forms stop at 128 characters, and first-boot setup refuses a longer administrator password instead of storing one that could never sign in. The limit is shared as `MAX_PASSWORD_LENGTH` in `@openbrf/shared` and set on the sign-in library.
- 26c5236: A personal identity number written with its century is refused when the
  century is not 18, 19 or 20, or when the birth date lies in the future. The
  person form and the import refuse it as not valid. A twelve-digit invoice or
  OCR reference whose last ten digits happen to form a valid number is no longer
  reported as a personal identity number, so it no longer stops the text it is in
  from being published.

  This is a check of what is entered. A number already stored keeps its index,
  and is found as before.

- 4047d01: Say why a plugin install failed in the reader's language.

  The plugins screen showed the installer's own English for every failed install,
  whatever language the interface was set to. An install failure is now recorded
  as a reason and the values its sentence needs - the download budget, a
  deadline, a size cap, a status code, a package name - and the screen and
  `openbrf plugin list` say it from the application's translations. Every way the
  install can fail has a reason of its own: a download that ran out of time or of
  the run's budget, a source the instance does not read or cannot reach, an
  archive that is too large or does not match its checksum, an archive that
  holds another package, and a failed or unexpected npm install.

  What the installer threw is still kept beside the reason, and `openbrf plugin
list` prints it under the sentence. A plugin that failed before this version
  has no reason recorded and keeps showing the text it had. The migration adds
  two columns and changes nothing already stored.

  Values taken from a plugin's archive, such as the package name its
  package.json gives, are stored cut to 214 characters. `openbrf plugin list`,
  `catalog` and `add` print control characters in anything they did not write
  themselves as escapes such as `\x1b`, so a catalog entry, an archive or an
  error cannot send instructions to the operator's terminal.

- 1a3d778: Fix a second set of defects in the public website, the page and menu editors
  and the document archive.

  - `news_list` keeps paging past a news item removed since the last call. Its
    cursor has a new form: a cursor issued before this release answers
    `not-found`, so start the list again without a cursor.
  - A `page_list` cursor whose sort order is out of range answers `not-found`
    rather than a server error.
  - A personal identity number in a link's address is found even when a stray
    `%` stands elsewhere in the link, or when the number's hyphen is escaped
    twice. The refusal places it by its block, without an offset into the
    block's words, and offsets in a FAQ block no longer shift past a link in an
    earlier answer. A link escaped more than four times over is decoded no
    further: the block is refused as if it carried a number, and the editor
    warns about it the same way.
  - A document for the members or the public whose title, binder or file name
    carries a personal identity number is refused, since a document list on the
    website prints all three. The file name is read as it will be stored, after
    the characters a stored name may not hold are removed. A board document is
    not affected.
  - A new page goes before the privacy notice in the board's list after the
    pages have been reordered, unless the board moved the notice up the list.
  - Removing a page records a menu entry under another entry for the same page
    once, as its parent's child, instead of twice.
  - `/nyheter?sida=` with seven or more digits shows the last page, like any
    other number past the end, and the index counts the news and reads the page
    at the same time.

- f408d9d: The lengths the housing cooperative's name, the bankgiro and plusgiro numbers and the SMS sender name may have are now shared between the settings forms and the server that enforces them (`HOUSING_COOPERATIVE_LIMITS`, `FINANCE_LIMITS` and `SMS_LIMITS` in `@openbrf/shared`), like the other settings lengths. No limit changes.
- f408d9d: The lengths the address, apartment, issue type and bookable resource forms and the first-boot administrator form allow, and the shortest password an account may have, are now shared between the forms and the server that enforces them (`ADDRESS_LIMITS`, `BOOKABLE_RESOURCE_LIMITS`, `ISSUE_TYPE_LIMITS`, `ADMINISTRATOR_LIMITS` and `MIN_PASSWORD_LENGTH` in `@openbrf/shared`), so the two cannot drift apart. No limit changes.
- 0703465: Harden how the API reads a calendar date.

  Every endpoint that takes a "YYYY-MM-DD" date now refuses one the calendar does
  not have, such as the 30th of February or a 13th month, with a 400 rather than
  reading it as a different day. Moves, lien notes and positions of trust also
  refuse it in the service, and a member list import checks the move-in date
  chosen for the whole file as it checks the date in a row.

  A lien note cannot be dated or released on a day that has not arrived, and a
  release cannot be dated before the note it releases.

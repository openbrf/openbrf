# ADR 0010: Message delivery without a realtime transport

Date: 2026-09-17

## Status

Accepted

## Context

The board chat is the first feature in this product where one person writes
something and another person is expected to see it without asking for it. Every
screen before it answered a question the reader had just asked, so how a change
reaches a screen has never had to be decided.

There is no realtime transport in this repository and nothing close to one. No
websocket package, no server-sent-events route, no event emitter, no adapter
registered on the Fastify instance at boot. The only push-like code in the
product is two hand-rolled polls with no shared helper: the plugin screen waits
for a restarted process every two seconds, and the import screen follows a
running import every one and a half. Neither is a transport; each is a screen
waiting out one job.

That absence is currently an accident rather than a decision, which is the
reason for this record. The next feature that wants something delivered would
otherwise reopen the question from nothing.

What an instance is bounds the answer. One application container and one
PostgreSQL container, one `app` service with no replicas, one instance per
cooperative, and a handful of people signed in at once. TLS is terminated by a
reverse proxy the association arranges for itself. Installing a plugin replaces
the process, and the restart gives in-flight HTTP ten seconds to drain before
exiting.

## Decision

### Delivery is a poll, on the cursor the comment threads already have

A screen reading a chat asks for what has been written since a cursor it was
given, every four seconds, and the server answers with a bounded page or with
nothing. The cursor is the composite `(createdAt, id)` the news comment thread
already uses, read in the opposite direction: the thread pages backwards from
the newest end, and the poll asks forwards from a point.

The comparison is written out rather than handed to the query builder's own
cursor option, in both directions. That option names a row and reads the
boundary values back out of it, and a message can be purged out from under a
reader between two requests - a room is erased on its own clock a year at a
time. The comparisons are against the two values the reader was handed, so the
row they came from no longer has to exist.

### The poll runs only while the tab is being looked at

The interval is cleared when `document.visibilityState` leaves "visible" and one
request is made immediately when it comes back. Without that, a screen left open
on a phone polls for days, and what a person returning to the screen is waiting
for is exactly the thing that arrived while they were away.

There is no request when the screen mounts: whatever mounted it has just read
for itself.

### Nothing is appended by the browser

A message reaches a screen because a read brought it. A write clears the box and
asks for a read; it does not put the row on the list. The answer to a write is
one message and the room is the whole of it, so a list assembled from both is a
list the server never stated. This is the rule the news thread already follows,
and it is what makes the poll the one delivery path rather than a second opinion
about one.

### The read is bounded and says whether more is waiting

A poll answers at most one page and reports whether the server had more. A
screen catching up after a week asks again at once, a page at a time, rather
than asking for a week of messages in one response.

### What was rejected, and why

**Server-sent events.** Cheaper to reach than expected - `rxjs` is already a
dependency and Fastify serves a stream - and rejected on four costs that are
specific to this deployment rather than general.

Every instance has a reverse proxy in front of it that the association
configured. nginx buffers a proxied response by default and will hold an event
stream until its buffer fills; the fixes are a buffering directive or a header,
plus a read timeout longer than the heartbeat. The failure mode is "the chat is
silent for some members and not others", which a volunteer board cannot
diagnose. That is the same class of ask the roadmap already refused for inbound
mail, where the board mailbox collects over POP3 rather than receiving mail
because port 25, an MX record and a public hostname are not things a board can
be asked to arrange. An event stream is a smaller ask and it is the same kind of
ask.

A stream is also in-flight HTTP that never finishes, so every plugin install
would burn the full ten-second drain and then kill the streams anyway. Closing
them first is writable, and it is new correctness the restart argument does not
currently have to carry.

In-process fan-out is sound today, because there is one process - the same
argument the token rate limiter already makes - but it is state nothing else
holds and it has to be rebuilt on every restart, which is a reconnect storm at
the moment the process is coldest.

And it is additive rather than a replacement: a cursor read still has to exist
for the first load and for the gap a reconnect leaves. SSE is polling plus a
stream, not polling instead of one.

**WebSockets.** New dependencies, none installed and none resolvable from the
lockfile, plus an adapter at boot. It carries the proxy cost of SSE plus an
upgrade the proxy must pass. And it introduces the shape ADR 0008 exists to
refuse: a socket authenticated once at handshake carries frames the global
authorization guard never sees, so either every frame re-derives the caller's
capabilities or the socket outlives a board term ending. The chat does not need
the bidirectionality - a message is written by a POST that has to be guarded,
scanned for a personal identity number and bounded anyway.

**Long polling.** It holds a connection per reader, so it inherits the proxy and
drain costs of SSE, and it still needs an in-process wakeup to deliver anything
sooner than its own timeout.

### A message write is not audited

A departure from the news comment precedent, recorded here because a reviewer
would otherwise read it as an omission. A comment writes `NEWS_COMMENT_POSTED`
because a member's own words about a notice are their data and their access
report has to say when they wrote them. A chat message is on that report in
full, carrying its author and its instant, so the entry would restate what the
row already says. And a board of eight at thirty messages a day is about eleven
thousand rows a year in a table the database refuses to update or delete and
every purge is forbidden to touch. Comments are occasional; a chat is not.

What is audited is the acts that change who can read a room. In the board chat
there are none: nobody is put into the room or taken out of it, an election is.

## Consequences

- **A reader waits up to four seconds.** That is the delay this decision buys,
  and it is the whole of what a board gives up. A conversation at that latency
  reads as a conversation; anything that needs to be faster is a different
  feature and is named below.
- **The endpoint shape does not change if the transport later does.** A stream
  would push the same messages a poll asks for, from the same cursor, answered
  by the same service method. Replacing the transport is a client change and a
  route added beside the existing ones, not a redesign of what a message is.
- **One poll is one request per open screen per interval**, answered by an index
  scan on `(chatId, createdAt)` that returns an empty page most of the time. Ten
  board members with the screen open is two and a half requests a second, which
  is below the noise floor of a register read. The chat endpoints carry no
  public rate-limit budget, deliberately: that decorator is for endpoints a
  stranger can reach, and what bounds writing here is a per-person window
  counted from the rows themselves.
- **The interval and the visibility rule live in one hook**, `usePoll` in the
  web client, rather than in the screen. The two existing hand-rolled polls are
  deliberately not migrated onto it: they work, each has a terminal condition
  the hook would have to grow a case for, and a refactor with no user-visible
  change does not belong in a pull request that ships a feature.
- **A cursor needs a row, so an empty room has none.** The forward cursor is
  taken from the newest message, and a room nobody has written in yet cannot
  supply one - so the poll re-reads the newest page until there is something to
  page from. Gating the poll on having a cursor is the obvious reading and it is
  backwards: a room with nothing in it is the one most likely to be sitting open
  on somebody's screen, waiting for the first line. Anything that later pages
  from a cursor inherits this case.
- **A poll is a request the reader did not ask for.** The visibility pause is
  what keeps that honest, and it is not optional.

## Revisit triggers

- **An instance runs more than one application process.** The in-memory argument
  against SSE dies first, and the whole comparison is worth redoing.
- **A use arrives that needs delivery faster than a few seconds** - a live count
  during a general meeting, say. Four seconds is fine for a conversation and is
  not fine for a vote being counted in a room.
- **The number of screens polling at once stops being a handful.** For this
  product that means a mobile application shipping a background poll, at which
  point the cost stops being per open tab.
- **A second feature wants push.** At that point the transport stops being the
  chat's and becomes the platform's, and building it once is cheaper than
  building it twice.

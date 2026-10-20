# ADR 0028: Support access the administrator opens

Date: 2026-10-20

## Status

Accepted (2026-10-20)

Amends [ADR 0021](0021-the-management-api.md): the management listener gains
one route that writes.

## Context

Whoever hosts an instance is a processor (personuppgiftsbiträde, GDPR art.
4(8)). It reaches the association's personal data only through access the
association's administrator grants, and the association's own audit log
records that access (Beslutslogg 72). The management API (ADR 0021) gives the
host counts and never a person. That covers billing and upgrades. It does not
cover support. When an administrator writes "the import screen says something
I don't understand" or "invitations aren't arriving", the person helping them
has to see what the administrator sees.

Today the only way to do that is to give the supporter an account. That breaks
three things the product holds to:

- **Every principal is a person in the register** (Beslutslogg 64; ADR 0009).
  A supporter would become a person on the association's own register, counted
  in the summary the host bills from and listed in the address book.
- **An account exists only by setup or by an invitation** (ADR 0005). Once it
  exists it does not end. Somebody has to remember to revoke the supporter's
  role, and nothing reminds them.
- **What an administrator does is the administrator's act.** A supporter
  holding `ADMIN` could change settings, install a plugin or grant a role, and
  the log would show them doing it as somebody the association appointed.

A processor acts only on the controller's documented instructions (GDPR art.
28(3)(a), art. 29). So support access needs four properties. It is opened by
the association, not by the host. It ends without anybody remembering to end
it. It cannot change anything. Every request made under it is written to the
association's log.

## Decision

### The administrator opens it, for a stated time, and may close it at once

An administrator (`association:manage`) opens support access from the
instance's settings. They choose how long it stays open: one hour, eight hours,
one day, three days or seven days. Seven days is the most. They also state a
reason in up to 500 characters. The reason is written only to the audit entry
that records the opening. Under the log's retention rule it is text with no
other home, and the form says it is kept for good.

At most one support access is open at a time. Opening a second one while one
is open is refused (409 `support-access-open`). The end time is fixed when the
access is opened and is never extended. Somebody who needs more time closes the
access and opens a new one, and the log shows both acts.

Any administrator may close it at any time, not only the one who opened it.
Closing it ends every session under it on the next request. An access that
reaches its end time ends in the same way, and nobody has to do anything.

The access also lapses as soon as the administrator who opened it no longer
holds `ADMIN`. It is the administrator's instruction, and it lasts no longer
than their grant. This is checked on every request rather than by revoking
anything when the role changes, for the reason `PrincipalService` derives
roles on every request: a stale copy keeps granting access after the reason
for it has expired.

In the product the act is called _opening_ support access, never consent. The
glossary keeps "consent" (samtycke) for a legal basis and for the board's
consent to a plugin. Opening support access is neither. It is the controller's
instruction to its processor.

### The host mints a sign-in link, and only while an access is open

Support access needs two keys. The administrator opening it is one. The host's
management token is the other, and neither works without the other.

The management listener gains `POST /v1/support-sessions`. The body is JSON:
`{ "supporter": "<name>" }`, where the name has 1 to 80 characters after
trimming and no control characters. It is the host's statement of who it is
sending, and the instance cannot verify it. The token is checked first,
exactly as for `/v1/summary`. The body is read only after the token matches,
up to 1 KiB, so an unauthenticated caller still gets no body parsed. The same
per-process budget covers both routes.

| Answer | Body                                           | When                                               |
| ------ | ---------------------------------------------- | -------------------------------------------------- |
| 201    | `{ "signInUrl", "expiresAt", "accessEndsAt" }` | An access is open and the body is valid.           |
| 400    | `{ "reason": "invalid-body" }`                 | Not JSON, over 1 KiB, or no valid `supporter`.     |
| 401    | `{ "reason": "management-token-invalid" }`     | As ADR 0021.                                       |
| 409    | `{ "reason": "support-access-closed" }`        | No access is open, or the one that was has lapsed. |
| 429    | `{ "reason": "rate-limited" }`                 | As ADR 0021.                                       |

`signInUrl` is `APP_URL` + `/app/support#` + a sign-in token: 32 random bytes,
base64url. The instance keeps only its SHA-256 digest (`hashOpaqueToken`). The
token is in the fragment, so a browser never sends it to a server, and it
appears in no access log or `Referer`. It is valid for ten minutes and can be
used once. The host hands the link to the supporter it named.

The 201 is the only answer that says whether an access is open. The 409 says
the same thing to the same caller. Nobody without the management token learns
whether an access is open.

ADR 0021 said the listener "answers `GET /v1/summary` and nothing else" and is
"read-only by construction". After this change it answers two routes. The new
route writes a sign-in token and an audit entry, and it writes nothing else.
Every other path and method is still 404 before the token is checked.

### A support session is not an account

The `/app/support` page reads the token from the fragment and removes it from
the address bar. It then posts the token to `POST /api/support/session`, a
public route. The route refuses a token that does not match, has been used, is
older than ten minutes, or belongs to an access that is no longer open. All of
those get the same 401, `support-sign-in-invalid`.

On success the route creates a support session, and nothing else: no `User`,
no `Person` and no Better Auth session. The session token is another 32 random
bytes, held by the instance only as a digest. It is set as a cookie of its own:
HttpOnly, SameSite=Strict, Secure whenever `APP_URL` is https, with the
`__Host-` prefix in that case. The session ends when the access ends, or eight
hours after sign-in, whichever comes first. It is never renewed.
`DELETE /api/support/session` ends it and clears the cookie.

The global guard reads this cookie before the sign-in library's session. When
a request carries it, it is the only credential considered. If it does not
resolve, the answer is 401, and the guard does not fall back to an account
session in the same browser. On every request the guard checks that:

- the session has not ended or expired;
- its access is open and not past its end time;
- the administrator who opened the access still holds `ADMIN` today.

### What a supporter can reach

A support session's principal is the administrator who opened the access,
narrowed in two ways.

**Its capabilities are a fixed list, not the administrator's.** The list is
`SUPPORT_CAPABILITIES`, written out by name and typed as
`GrantableCapability`. A seat-bound capability cannot appear in it, so a
supporter never reads a household's binder (ADR 0017), whoever opened the
access. It names what an administrator uses to run the instance:

`association:manage`, `association:read`, `addressBook:read`,
`memberRegister:read`, `invitation:send`, `signupRequest:decide`,
`systemRole:manage`, `boardPosition:manage`, `issues:configure`,
`bookings:configure`, `documents:manage`, `site:manage`, `events:manage`.

Every other capability is withheld, for one of three reasons:

- **It discloses more than a name.** `apartmentRegister:read`,
  `protectedData:reveal` and `registerReport:export`. A supporter never sees a
  personal identity number, a lien or a protected person's details. A
  protected person stays masked exactly as on any screen without the reveal.
- **It is the association's casework or correspondence with its members.**
  `issues:handle`, `bookings:manage`, `motions:handle`, `meetings:manage`,
  `memberCharges:manage`, `fees:manage`, `dataProtection:manage`,
  `boardMailbox:handle`, `sublets:handle`, `keyOrders:handle` and
  `chat:moderate`.
- **It is a person's own act, and a supporter has no self.** `self:manage`,
  `residentDirectory:read`, `issues:report`, `news:comment`, `bookings:book`,
  `events:attend`, `motions:submit`, `sublets:apply`, `keyOrders:place` and
  `chat:participate`.

A capability added to `CAPABILITIES` later is not a supporter's until somebody
decides it should be. A spec fails for any capability that is in neither the
support list nor the withheld list. ADR 0021 names its channels for the same
reason: something added later should count for nothing until it is decided
that it should.

**It cannot change anything.** The guard refuses `POST`, `PUT`, `PATCH` and
`DELETE` from a support session with 403 `support-access-read-only`, before
any capability is checked. The one exception is `DELETE /api/support/session`,
which is public and ends the caller's own session. The guard also refuses a
plugin's routes to a support session, whatever their method. Core cannot know
what a plugin does on a `GET`, so it does not let a supporter find out. The
bearer-only resource route takes no cookie and is unaffected.

The interface knows when it is serving a support session. It shows on every
screen who the supporter is, that the access is read-only and when it ends,
and it offers no control that would send a change.

So a supporter looks and the association acts. A setting the supporter finds
wrong is changed by the administrator, who is told what to change. Every
change to the association's records stays the act of somebody on its
register. Letting a supporter change things would be a different decision,
with its own ADR. It would need to say whose act the change is.

### Everything a supporter does is in the audit log

A new audit channel, `SUPPORT`, records that a request came through a support
session. Every entry on it has two parts:

- the actor is the administrator who opened the access, the person on whose
  instruction the request was made;
- a reserved `support` key in the context names the support session, and
  `AuditLogService.record` adds it.

This follows the connected app: an entry names the member who connected an app,
and the app is named in a reserved key.

The entries:

| Action                    | Channel      | Actor                     | Written when                                                                                                            |
| ------------------------- | ------------ | ------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `SUPPORT_ACCESS_OPENED`   | `WEB`        | the opening administrator | Opened. Context: the end time, the hours chosen and the reason.                                                         |
| `SUPPORT_ACCESS_CLOSED`   | `WEB`        | the closing administrator | Closed by hand. Reaching the end time writes nothing; the opening entry already states it.                              |
| `SUPPORT_SESSION_ISSUED`  | `MANAGEMENT` | none                      | The host minted a link. Context: the access and the supporter's name.                                                   |
| `SUPPORT_SESSION_STARTED` | `SUPPORT`    | the opening administrator | The link was used.                                                                                                      |
| `SUPPORT_REQUEST`         | `SUPPORT`    | the opening administrator | Every request the guard lets through. Context: the method, the route as the router matched it, and its path parameters. |
| `SUPPORT_SESSION_ENDED`   | `SUPPORT`    | the opening administrator | The supporter signed out.                                                                                               |

`SUPPORT_REQUEST` never records the query string, because a search box can put
a name there. It records the path parameters because they are identifiers,
and identifiers are what lets the association answer "whose record did the
supporter open?".

Any entry written while a support session's request is being served goes on
`SUPPORT`, whatever channel the call site passed. Some audited reads write
their entry on a `channel: "WEB"` hard-coded at the call site; the member
register extract is one. Without this rule, such an entry would claim the
administrator did it themselves in the web interface. The request's support
session is held in request-scoped storage, set by the guard, and
`AuditLogService.record` reads it. So the channel is still derived from how
the caller arrived, as `ActorContext` requires, and it no longer depends on
each call site getting it right. Every audit write goes through `record`,
including `withAuditedRead` and `recordProtectedDataReveal`, and nothing
writes the table any other way.

Each support session has a budget of 120 requests a minute. Above it the guard
answers 429 `rate-limited` with `Retry-After`. This bounds the `SUPPORT_REQUEST`
entries a runaway tab could write.

`SUPPORT` is not one of the channels that keep a trial alive in the management
summary's `boardActivityOn`. ADR 0021 names those channels: a supporter looking
at an instance is not its board using it.

### What is stored

Two tables:

- **`support_access`**: when it was opened and by whom, when it ends, and when
  it was closed and by whom. The reason is not stored here; it is in the audit
  entry. Both person columns are covered in the data subject access report's
  column coverage (ADR 0019) by the audit actions their person acted as:
  `SUPPORT_ACCESS_OPENED` and `SUPPORT_ACCESS_CLOSED`.
- **`support_session`**: the access it belongs to, the supporter's name, the
  digests of the sign-in token and the session token, and when the session
  was issued, started, expires and ended.

Neither table is purged. The audit entries name these rows, and the rows are
never edited after a session ends, so the log can still resolve a reference
years later. A supporter's name is personal data about the processor's staff
member, not about anybody on the association's register. It is kept as the
association's record of who accessed its data.

The settings screen shows the open access, its sessions with each supporter's
name and times, and the accesses that came before.

## Consequences

A host that has not configured the management API cannot mint a link, so
support access cannot be used on its instances. This is intended. A
self-hosting association with no host has nobody to send support, and a
second way in that needed no host token would be a key the association
holds alone, so it could be given away without the processor's agreement
behind it.

A supporter sees the instance through the thirteen capabilities above, read
only. On some questions they cannot help:

- a fee notice that looks wrong;
- an issue that went to the wrong queue;
- a letter in the board mailbox.

The board shows them its screen instead, outside the product. Widening the
list is a change to this ADR. That is deliberate: the default for something
the processor sees should be "not yet decided".

Read-only is enforced by method. A `GET` that changes a row other than its own
audit entry is already a defect, because a crawler or a prefetch can trigger
it. A support session does not make such a `GET` worse, but it is a new caller
that can trigger one. The PR that builds this lists every `GET` route a
support capability opens and confirms that none of them writes.

The administrator's own data subject access report lists the `SUPPORT` entries
written under their access, with "Via: Support". The requests were made on
their instruction, so the report shows them as theirs, as it does for a
connected app's calls.

Support access adds a public route that accepts a credential:
`POST /api/support/session`. It takes a 32-byte single-use token, so guessing
cannot succeed. The route still carries `@PublicRateLimit`, ten attempts a
minute per client address, like every other public route that writes.

The supporter's name is whatever the host says it is. If a host lies about who
it sent, that is a breach of its processor agreement, not something this
instance can detect. The entry `SUPPORT_SESSION_ISSUED` records what it said.

The management listener stops being read-only by construction. What it can
write is bounded: one sign-in token for an access the administrator has
already opened, and one audit entry. A leaked management token, used from
inside the host's network, still cannot get a session while no access is open.

## Settled while building it

The decision above stands as accepted. Building it settled these points, which
the text above leaves open or states more broadly than the code can:

- **`addressBook:write` is withheld.** The lists above name every capability
  but this one. It gates the register's writes, and no screen reads by it that
  `addressBook:read` does not already open, so it is withheld as a capability
  whose only purpose is a change. The spec that holds the two lists to
  `CAPABILITIES` would otherwise have failed on it.
- **The support session's own routes.** `POST /api/support/session` (signing
  in with a new link from a browser that holds an old cookie) is exempt from
  the guard's support branch as well as `DELETE`. Neither writes a
  `SUPPORT_REQUEST` entry: the session's start and end are entries of their
  own.
- **Read-only is an allow-list.** A support session may send `GET` and `HEAD`
  and nothing else, so a route answering some other method is refused to it
  without anybody having to name the method. That is stricter than refusing
  `POST`, `PUT`, `PATCH` and `DELETE`, and refuses the same changes.
- **Correspondence and casework under a granted capability.** Two answers
  carry what this ADR withholds under a capability it grants. The contact
  form's messages are read under `signupRequest:decide`, so their route is
  closed to support sessions by name (`@ClosedToSupport`) and the settings
  screen does not offer the inbox to one. A person's detail carries the
  requests they made about their own data, the grounds the board decided them
  on and a legal hold's reason under `addressBook:read`, so those fields are
  left out for a reader without `dataProtection:manage`. Every account that
  reads the address book holds that too.
- **Signing in again.** A browser that signs in with a new link while holding
  an earlier session's cookie has the earlier session ended.
- **Routes refused whatever the method.** Besides a plugin's routes, the guard
  refuses the sign-in library's routes under `/api/auth/`, which are about
  accounts, and every route that declares no capability unless it is opened to
  support sessions by name (`@OpenToSupport`). Such routes answer from the
  caller's own record: the apps they connected, the actions their whole grant
  allows. Two are opened: `GET /api/me`, which answers for the support session
  itself, and `GET /api/documents`, whose shelves are read from the
  capabilities. The refusal is 403 `support-access-refused`.
- **A support session has no self.** Its principal holds none of the
  administrator's roles. The media route refuses it a household's files, a
  feed picture and an issue photo by the reporter's path, whatever the
  administrator who opened the access holds. The public website treats it as
  nobody: it is not a reader of member-only pages, and an account session in
  the same browser is not consulted.
- **The access lapses with the grant itself.** The access records the
  `system_role` row of the opener's `ADMIN` grant, and is open only while that
  row exists. A revoked grant is deleted and a new one is a new row, so an
  administrator demoted and appointed again does not bring the access back.
- **Request-scoped storage.** The guard marks the request, and an interceptor
  runs the handler inside the storage `AuditLogService.record` reads. A guard
  returns before the handler runs, so it cannot hold the storage around it.
- **Neither table is deleted from.** The runtime role holds no `DELETE` on
  `support_access` or `support_session`.
- **The management route's failure.** A failure while issuing a link answers
  500 `support-session-unavailable`. The summary's own stays
  `summary-unavailable`.
- **The interface.** Every screen carries the notice naming the supporter, and
  no screen offers a control that sends a change. The web app has one
  read-only signal, the `support` field `GET /api/me` answers, and each screen
  a support capability opens reads it beside the capability: what it shows
  follows from the capability, what it lets the viewer change from both. A
  form a supporter may read stays on the screen with its fields disabled; a
  form that only creates something is not shown; controls that only read,
  such as filters, paging and the period of a calendar, keep working. The
  settings screen puts each panel in a disabled fieldset as well. Should a
  change reach the API anyway it answers 403 `support-access-read-only`, and
  the screen says the access is read-only.
- **Signing out.** Only the server ends a support session, because its cookie
  is HttpOnly. A sign-out that fails, offline or refused, leaves the supporter
  on the screen with the session still named, says it is still open and offers
  to try again.

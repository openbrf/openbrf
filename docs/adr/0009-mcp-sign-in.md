# ADR 0009: Signing in an MCP client

Date: 2026-09-14

## Status

Accepted

## Context

[ADR 0008](0008-action-registry.md) gave the platform one place to be asked to
do something, and said that the callers which need it are external programs
holding a token that acts as a person. This is how such a program obtains that
token, and what the token is worth once it has one.

The requirement is narrow and awkward. A member has to be able to point a
program they chose - a chat client, an assistant, something the association had
written - at their own cooperative's instance, sign in as themselves, and let
that program do a subset of what they could do in the browser. The association
has to be able to see that this has happened and to stop it. Nothing the member
grants may exceed what the member themselves may do, and it has to stop
exceeding it the moment the member's own standing changes.

Three constraints shaped the answer more than the rest:

The register is statutory. What an association holds about its members is not
data whose exposure is a product decision, so the arrangement has to be
auditable and revocable rather than merely convenient.

The board is not an implementer. A board member reading a consent screen, or a
list of what has been connected, is reading it in Swedish and is not going to
reason about audiences and grant types.

The instance is self-hosted, often on one small machine, and is restarted
whenever a plugin is installed. Anything that only works while a process stays
up has to be honest about that.

## Decision

### OAuth 2.1, through the sign-in library already in the tree

`better-auth` is already the account model (ADR 0005). Its `mcp()` plugin
registers an OAuth provider, and `cimd()` lets a client identify itself by the
URL of its own metadata document. Using them means the protocol details - PKCE,
the authorization code, the token endpoint - are the library's problem, and what
remains ours is what is specific to this product.

The three packages are ESM-only with no `require` condition, while `apps/api`
compiles to CommonJS. They load anyway, because `require(esm)` is available on
the Node this ships on. That is a dependency on the runtime rather than a
preference: on a Node without it the application does not start at all, and it
fails at the first import rather than at a call site.

Two things hold it. `package.json` declares `"node": ">=26 <27"`, and the
production image pins the runtime by digest rather than by tag, so the version
that runs is the version this was verified against. Neither is decoration. The
alternative if it ever stops holding is a dynamic `import()` behind a lazily
initialised provider, which costs an await on a path that currently has none.

### The resource is a plugin's route, not one core mounts

Core mounts no MCP endpoint. The thing an external client talks to is a
connector plugin's own route, declared in its manifest as
`oauthProtectedResource` and mounted under `/api/plugin/<id>/` like any other
plugin route. Its full URL is the audience every token is bound to.

At most one installed plugin may declare it. Where two do, the one installed
first keeps it and the newcomer is refused at install, or carries a finding if
it reached the volume anyway. The alternative - falling back to a default when
there is a conflict - moves the audience, and every token already issued then
stops matching. A member's connection would break because somebody installed an
unrelated plugin.

An instance with no connector still advertises a default path,
`/api/plugin/mcp-connector/mcp`, so that sign-in is configurable, discoverable
and testable before a connector exists. Nothing is mounted there and the
guard's Bearer branch is not installed. A default that armed the guard would
convert a real route to Bearer-only the moment any plugin took that id and
served that path, so the id is reserved as well: an install taking it is
refused unless its manifest declares the resource.

### Opaque tokens, looked up on every call

An access token carries no claims. Every call resolves it by looking the row up
and then re-deriving the person's capabilities from the register. That costs one
indexed query plus the capability query per call, and buys the property the
whole arrangement exists for: deleting the row is the revocation, so a
disconnect takes effect on the next request rather than at the end of the
token's lifetime, and a board term ending narrows every app that person
authorised the same night it narrows the person.

The alternative considered was introspection -
`createMcpProtectedRequestHandler` with a `remoteVerify` endpoint. It needs an
internal confidential client minted at boot, a secret stored and rotated, and an
HTTP round trip from the process to itself, and it buys session-liveness
checking that is not wanted here. Lookup is one query on a unique column.

What is stored is a digest, never the token: a token is a bearer credential, so
a database copy or a backup must not be enough to act as somebody. The digest
function is ours and is pinned through `storeTokens.hash` rather than left to
the library's default. The default is the same construction today, but a changed
default would not fail loudly - every live token would simply stop resolving,
reading as though every member had disconnected every app at once.

### No revocation on a capability change

A board term ending leaves the token in place. Every call then fails the live
capability check, so nothing is granted that should not be, but the connection
stays in the member's list looking healthy until they try to use it. Revoking
on change would mean watching every fact that feeds a capability and deciding
what a partial narrowing means for a token. That is the next change rather than
this one.

### Two coarse scopes, and a scope is not a grant

`mcp:read` and `mcp:write`, plus `offline_access` for the refresh token. One
scope per capability would put thirty-five internal names on a third-party
consent screen; one scope per action would couple a token to the catalogue and
break every grant on a rename.

A scope is a **ceiling** and never a grant. Dispatch refuses a write without
`mcp:write` before it checks the capability, so the refusal is scope-shaped and
names a scope a client can ask for; it then re-derives the person's capabilities
and decides the actual question. The cost is a 403 that can name `mcp:write` and
cannot name the missing capability. Accepted: naming the capability would tell
an external program the internal authorization vocabulary of an association it
has been given limited access to.

`openid`, `profile` and `email` are deliberately absent. Without them the
authorization-server document is the plain OAuth one rather than the OpenID
variant, no id token is issued, the audience is the resource alone, and a client
never receives the person's name or address. A client that wants to know who it
is acting for can ask the platform, through an action, under a capability.

### Discovery is public, and there is no CORS

The two authorization-server documents and the protected-resource document are
`@Public()`. This is a fourth kind of public route beyond the three the
decorator names, and the reason is narrow: a discovery document says how a token
may be obtained, carries no personal data and nothing about the association, and
has to be readable before any token exists. Requiring a token to find out how to
get a token is a loop.

No CORS headers are sent and none are needed: these documents are fetched
server-side by the clients this targets. Adding CORS would be the first in a
codebase whose entire cookie arrangement rests on same-origin. A browser-based
client is the trigger to revisit it, not something to pre-empt.

### The resource route accepts a token and nothing else

The authorization guard takes an explicit branch for the declared resource path
and every path beneath it. On that branch no session lookup runs at all - not as
a fallback, and not after a token fails. MCP is explicit that a server must not
accept a token that was not issued for it, and the same rule rules out a
credential that is not a token at all. It also removes CSRF from the route by
construction, since nothing it accepts is sent by a browser automatically.

Sub-paths are included. The alternative - one exact path per connector - would
leave a sub-path of a real endpoint falling through to the cookie path, where
the module seal has already made every plugin controller an ordinary
session-authenticated route. It would answer, with the browser's own cookie,
which is exactly what this route is not.

The `Authorization` header is read from the raw headers rather than through the
guard's `Headers` copy, which keeps only string values. Two `Authorization`
headers arrive as an array; through the copy that is dropped and the request
authenticates as nobody, and here it is refused. An ambiguous credential is not
a missing one.

### Rate limiting has three layers, and only one of them is honest about scale

The library's own per-endpoint limits are in-memory and per process. The
per-token limiter, which is what answers the MCP specification's requirement, is
also in-memory and per process, keyed on the access-token row id and charged in
the guard rather than at dispatch - so it covers every request on the route,
not only the ones that reach a handler.

It is charged after the token has resolved, which the key forces: the row has
no id until it has been read. So a refused request has already paid for the
four indexed reads that resolution makes. That is the deliberate side of the
trade. Keying on something available earlier - the presented value, or its
digest - would let any caller at all open a counter, and the map would become
somewhere to put unbounded rubbish. What this bounds is the work behind the
route, not the cost of working out whose budget to charge.

Per process means it resets when the process does, and installing a plugin
replaces the process. So it bounds what one connection can do to an instance; it
is not a quota anybody is accounted against. A shared counter is the next change
if that becomes the wrong answer.

It is deliberately not `PublicRateLimitGuard`, which is inert without its
decorator and keys on the client address. A hosted connected app's calls all
arrive from one egress range, so an address key would throttle either the whole
cooperative or nobody.

### Fetching a client's metadata document is bounded by us

`cimd()` is what makes a client able to identify itself by a URL, which makes
this the one place in the product where an unauthenticated party chooses a URL
this server will fetch. The library documents that it rejects loopback and
private hosts, but a defence that exists only in a dependency is not one we
control, so the fetch is bounded here: HTTPS only, no address literals in any
textual form, no credentials, no reserved or single-label hostnames, every
resolved address checked against the private, loopback, link-local, unique-local,
carrier-grade-NAT, cloud-metadata and wrapped forms, a short whole-operation
timeout, and a response size bounded on the bytes as they arrive rather than on
a `content-length` header a hostile server controls.

The document is fetched without following redirects, which is the library's own
rule and is about impersonation rather than about forgery: the document must be
served _at_ the client id URL for that URL to be an identity, so an open
redirect on an honest client's host would let a stranger serve that client's
metadata.

The underlying transport resolves the hostname once and pins the approved
address for the connection while keeping the hostname for SNI, which closes the
window between resolving a name and connecting to it. Our own checks run first
and are kept rather than deferred to it: they refuse categories the transport
does not, and they run before any socket is opened.

### One deviation in the schema, and why

The tables are the library's and are copied as generated, with their model names
intact because the adapter reaches a delegate by name. One foreign key differs.

`auth_oauth_client.userId` records who registered a client, and the library
cascades it. Every other table reaches a client by `clientId` and cascades, so
deleting one client row takes every member's consents and tokens for that client
with it. Erasing the single person who happened to be recorded as the registrant
would therefore disconnect the app for everybody else, with no audit entry and
no board decision behind it. It is pinned to `SET NULL`. The three tables that
genuinely belong to one person - access tokens, refresh tokens and consents -
keep `CASCADE`, which is what makes the single delete of `auth_user` in the
purge erase them all.

These tables are service tier: no append-only trigger, no revoked `UPDATE`. A
token table that cannot be deleted from cannot be revoked from, and cutting a
connection off at once is the entire point of holding opaque tokens. What a
token did is in `audit_log_entry`, which is append-only and carries both the
channel and, in its context, the client that acted.

### There is no record of what was consented to beyond the consent itself

An earlier design snapshotted the action list a person agreed to, per person and
per client, and refused anything outside it at dispatch. It is not built. What a
connected app may do is exactly what the person may do at the instant of the
call, filtered by the coarse scope on the token, and the consent screen says so
in as many words.

The reason is that the snapshot is a promise the platform cannot keep. The
catalogue changes when a plugin is installed, upgraded or disarmed; a snapshot
taken at consent would drift from it silently, and reconciling the two is a
second authorization decision able to disagree with the first - the thing ADR
0008 exists to prevent.

### An MCP client is not a processor

Under art. 28 an MCP client is the member's own tool rather than a processor the
association engaged, so no data-processing agreement is sought. A recipient that
exists is listed regardless: each registered and consented client appears in the
record of processing with `seededClassification: INDEPENDENT_CONTROLLER`, which
the schema already defines as deciding its own purposes. The art. 28 reasoning
is the justification for that classification, not a substitute for the row.

## Consequences

Changing `APP_URL` invalidates every issued token, because the resource URI is
the audience. `APP_URL` is now refined to be an https URL or a loopback address,
which turns a misconfiguration into a named boot error rather than a stack trace
from inside the library. `docs/deployment.md` carries both.

The audience is decided by which connector is installed, so removing and
reinstalling a connector under a different plugin id breaks every existing
connection. Members reconnect; nothing is lost but the connections.

The per-token limiter and the library's own limits are both per process, so an
instance behind more than one process has as many budgets as it has processes.
Single-process is the deployment this ships.

A member's connection survives their board term ending and simply stops working.
Until revocation-on-change exists, a member whose standing narrows will see an
app fail rather than see it disconnected.

A window remains between a client presenting a metadata URL and the document
being fetched, in which the document could change. Nothing in the protocol
closes it; re-fetching on every call would make an unauthenticated party able to
make this server fetch on demand.

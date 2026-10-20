# ADR 0031: A device token for a plugin's own routes

Date: 2026-10-19

## Status

Accepted. Extends [ADR 0003](0003-plugin-loading-and-module-resolution.md); its
rule that `@Public()` on a plugin route has no effect stands.

## Context

Every route a plugin contributes is mounted inside the application's
authorization guard and raised to a capability floor, and `@Public()` on a
plugin route is overridden (ADR 0003). That is why no plugin can be the route on
an instance that skipped the session check, and it stays.

It also means a plugin cannot serve anything that has no person behind it. A
screen in the stairwell has no account and no session. It is a device the board
put there, and it needs to read the same few things all day: what to show, and
the pictures that go with it. The two ways to give it that today are both wrong.
A person's session cookie in a kiosk browser makes the screen that person, with
everything they may do and a session that ends when they leave the board. A
public route makes the screen's content readable by anyone who knows the
address.

What the screen needs is narrower than either: a credential that reaches one
plugin's read-only routes, names one device, never names a person, and can be
cut by the board at once. The connected-app token ([ADR 0009](0009-mcp-sign-in.md))
is the closest thing the instance has, and it is the opposite on every count
that matters here: it acts as a person, carries that person's capabilities and
expires in minutes.

Nothing here is specific to signage. A meter reader in the laundry room or a
door display would need the same.

## Decision

### Words

A **device token** (enhetstoken) is a credential the board issues to one device
for one plugin's device route. It identifies the device, never a person. A
**device route** (enhetsväg) is a path under a plugin's own mount that answers
to a device token and to nothing else. Both terms are in GLOSSARY.md.

### The manifest declares the routes

```jsonc
{
  "openbrf": {
    "id": "signage",
    "deviceRoutes": [{ "id": "screen", "path": "screen" }],
  },
}
```

| Field  | Required | Meaning                                                                                                                         |
| ------ | -------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `id`   | yes      | Lowercase letters, digits and single hyphens, 2 to 32 characters. A token is issued for one route by this id.                   |
| `path` | yes      | A path under the plugin's own mount, written as `oauthProtectedResource` is. The route covers the path and everything below it. |

A plugin declares at most four. Two routes may not overlap, and no route may
overlap the plugin's `oauthProtectedResource`. The board reads the routes on the
install consent screen - "can be reached by devices holding a token the board
issues" - and a republished version that adds one or moves one carries
`device-routes-widened` until the board consents again.

**A plugin with a device route reads nothing from the register.** A manifest
declaring `deviceRoutes` beside `addressBook:read` or `addressBook:readContact`
fails validation. A device is a screen on a wall that anyone in the stairwell
reads, and this is the rule `site:blocks` has for the website: what reaches it
must not have a path from the register that the board did not open on purpose.
Personal data reaches a device only through an addon
([ADR 0030](0030-plugins-that-extend-plugins.md)), which is installed and
consented to by itself and states what it hands over, at an extension point
that may not accept contact details.

### What a device route answers

The guard's branch for a device route comes before the cookie path, as the
protected resource's does, and returns on its own:

- **Only `GET` and `HEAD`.** A device reads. The seal refuses, at load, a plugin
  that declares any other method on a path under a device route
  (`module-refused`, naming the route), and the host answers the `OPTIONS`
  preflight itself.
- **Only `Authorization: Bearer <device token>`.** The session cookie is not
  read on a device route at all, so a board member's browser that opens one is
  refused like anyone else. Two `Authorization` headers are refused, as on the
  protected resource. A token in a query string is never read: query strings are
  written into request logs.
- **The token must be live, and for this route of this plugin.** It is looked up
  by its digest, and refused when it is unknown, revoked, or issued for another
  plugin or another of its routes. Every refusal is the same 401 with
  `WWW-Authenticate: Bearer realm="device"` and the reason
  `device-token-invalid`, so the answer does not say whether a token ever
  existed.
- **A plugin that is not serving answers 404**, before the token is read, as
  every route of a plugin that is switched off does.
- **No person is on the request.** A device request carries no principal and is
  not marked as authenticated in the sense ADR 0008 uses, so `host.actions.list`
  and `invoke` refuse it. A plugin cannot turn a screen into a caller of the
  action registry.
- **No capability floor.** The floor exists so that a plugin cannot show a
  person what the core would not show them, and there is no person here. What
  stands in its place is the rule above: a plugin with a device route holds no
  register permission.
- **Rate limited per token**: a 60-second window, 120 calls by default
  (`OPENBRF_DEVICE_TOKEN_CALLS_PER_MINUTE`), answered 429 with `retry-after`,
  through the limiter the protected resource uses. Refused tokens are limited per
  client address as the public forms are.
- **Cross-origin reads are allowed, and nothing else is.** A device route answers
  `Access-Control-Allow-Origin: *`, allows the `Authorization` and
  `If-None-Match` headers and the `GET` and `HEAD` methods, exposes `ETag`,
  `Retry-After` and `WWW-Authenticate`, and never sends
  `Access-Control-Allow-Credentials`. It sends them on every answer, the 304 and
  the 401, 404 and 429 refusals included. A page on another origin sees only the
  headers it is allowed to, and the 401's `WWW-Authenticate` is how a device
  tells that its token is gone (below): without it, or on a refusal without
  these headers, a web player would read a revocation as a failure to connect
  and go on showing what it had. These are the first CORS headers in the API,
  and the reason there were none still holds everywhere else: the cookie
  arrangement rests on same-origin. It does not
  reach here, because a device route reads no cookie. What authenticates is a
  header no browser sends on its own, so a page on another origin can call the
  route only with a token it already holds. A packaged TV app's origin is not
  known in advance and is not a web origin the instance could list, so an
  allowlist would have nothing to name.
- `cache-control: no-store` on every answer. The device keeps its own copy.

### The plugin issues tokens through the host

The host object gains `host.devices`:

```ts
export interface PluginDevices {
  /**
   * Issues a device token. The request is the one the plugin's own route
   * received from a board member's browser.
   */
  issue(
    request: ActionRequest,
    options: { route: string; subject: string; label: string },
  ): Promise<{ token: string; device: DeviceTokenSummary }>;

  /** The plugin's own tokens, newest first. Revoked ones included. */
  list(filter?: {
    route?: string;
    subject?: string;
  }): Promise<readonly DeviceTokenSummary[]>;

  /** Revokes one of the plugin's own tokens. True when it was live. */
  revoke(tokenId: string, request?: ActionRequest): Promise<boolean>;

  /** Which token a request on one of the plugin's device routes came with. */
  current(request: object): DeviceTokenSummary;
}

export interface DeviceTokenSummary {
  readonly id: string;
  readonly route: string;
  /** The plugin's own name for the device, such as its screen id. */
  readonly subject: string;
  /** The board's name for it, such as "Entrance B, ground floor". */
  readonly label: string;
  readonly issuedAt: string;
  readonly lastUsedAt: string | null;
  readonly revokedAt: string | null;
}
```

**Issuing is a board member's act.** `issue` takes the request its route was
serving and reads the person from the host's mark on it, as `host.actions` does.
It refuses unless the request came through the web interface - not through a
connected app's token - from a person holding `site:manage`, now. A screen in
the building shows what the association publishes, and deciding what is
published is the board's (`site:manage`); the administrator holds it as well.
The plugin cannot issue a token on its own initiative, and cannot issue one for a
route it did not declare.

`subject` is the plugin's handle on the device, 1 to 64 letters, digits, `.`,
`_`, `:` or `-`, so that `current(request)` tells a route handler which screen
is asking. `label` is the board's own name for the device, at most 80
characters. A plugin holds at most 200 live tokens.

**Revoking is the board's, the plugin's, and always at once.** The plugin may
revoke its own tokens, with the request when a person asked for it. The core
also has a devices screen of its own, under `site:manage`, listing every live
device token on the instance by plugin, with who issued it, when it was last
used and a revoke button. It is not the installed plugins screen, which is the
administrator's: the board issues the tokens, so the board has to be able to cut
them. Revocation therefore never depends on the plugin's own screen being right. The
token is looked up on every call and nothing about it is cached, so the next
call after a revocation is refused.

### The token itself

- **Format:** `obrf_dt_` followed by 32 random bytes in base64url. The prefix is
  for secret scanners and for a person reading a log line; nothing parses it.
- **Stored as its digest**, with `hashOpaqueToken`, the unkeyed SHA-256 the
  connected-app tokens and invitations use. A 256-bit random token needs no slow
  hash. The token is returned once, by `issue`, and never again.
- **No expiry.** A screen runs unattended for years, and a token that expired
  would blank it at a moment nobody chose. What stands in for expiry is that the
  board sees every token with the day it was last used, and revokes it. A plugin
  that wants rotation issues a new token and revokes the old one.
- **The row:** `PluginDeviceToken` with `id`, `pluginId` (cascading from the
  installed plugin), `routeId`, `subject`, `label`, `tokenHash` (unique),
  `issuedAt`, `issuedByPersonId`, `lastUsedAt`, `revokedAt` and
  `revokedByPersonId`. `lastUsedAt` is written at most once a minute per token,
  so a screen polling every thirty seconds does not write on every call.
  `issuedByPersonId` and `revokedByPersonId` name people, so the change that adds
  them answers for both under [ADR 0019](0019-every-column-that-names-a-person-is-answered-for.md).

### What is recorded

Issuing and revoking are audit entries, `DEVICE_TOKEN_ISSUED` and
`DEVICE_TOKEN_REVOKED`, with the plugin, the route, the token's id and the
plugin's subject, and never the token or its digest. Not the label either: it is
the board's own text on the token's row, and the audit log copies no free text
from a record that has a home of its own (amended in the change that implements
this record). A revocation the plugin made without a person
is recorded on the `PLUGIN` channel with no actor. Using a token is not an audit
entry: a screen polling all day would bury the log, and `lastUsedAt` answers the
question an entry would.

### Removing, switching off, republishing

Removing a plugin deletes its tokens. Switching it off keeps them and answers
404 on its device routes until it is switched on again, so the screens can be
paused without anybody walking round the building to pair them again. A
republished version that drops a device route revokes the tokens issued for it.

A device therefore reads the two answers differently, and a plugin that ships a
device must make it do so. The 401 with `WWW-Authenticate: Bearer
realm="device"` is the only answer that says its token is gone, and only then
may the device forget it. A 404 says that the plugin is not serving now: the
device stops showing what it had, keeps its token, and asks again later. A
removed plugin also answers 404, so a device whose plugin was removed waits
until somebody resets it; the plugin's own documentation says how. That 404
carries the device route headers as every other answer does, so the host keeps
the device routes of a removed plugin when its row is deleted, and reads the
routes the board consented to while plugins are switched off for the instance
(amended in the change that implements this record).

## Consequences

- The core gains a devices screen under `site:manage`, with its i18n and its
  end-to-end proof, in the change that adds device tokens.
- A screen holds a credential that reads whatever the plugin serves on that
  route, for as long as the board leaves it. Whoever unscrews the screen from the
  wall has it. That is why it is read-only, scoped to one route, cut at once and
  shown with the day it was last used.
- A device route is outside the capability model. What protects it is the
  manifest rule that its plugin reads nothing from the register, the addon's
  separate consent for anything that does, and the board's act of issuing each
  token.
- The API now sends CORS headers on device routes and nowhere else. The test
  that keeps it that way asserts that no other route sends them, and that a
  device route sends them, `WWW-Authenticate` exposed, on its 401, 404 and 429
  as well as on a 200.
- The `deviceRoutes` field and the device-route consent text are in version 2 of
  the catalog index (ADR 0030).
- `host.devices` is added after this contract version shipped and is
  feature-detected, as `host.actions` is.
- `@Public()` stays without effect on a plugin route. A device route is not
  public: it is a different credential, checked by the same guard.

## Rejected alternatives

- **`@Public()` with a secret in the URL.** Readable by anyone the URL reaches,
  written into every request log on the way, and impossible to revoke without
  changing the address.
- **A person's session on the screen.** The screen becomes that person, with
  everything they may do, until their session ends or they leave the board.
- **A connected-app token.** It acts as a person and carries that person's
  capabilities, which is the property a screen must not have, and it expires in
  fifteen minutes.
- **Signed URLs per picture.** The screen still needs a credential to get the
  list of URLs, and that credential is this one.

## Revisit triggers

- **A device needs to write**: a button on a screen, a sensor reporting a
  reading. That needs its own decision about what a device may change and how
  it is attributed, not a wider method list here.
- **A plugin needs a device route and the register**: the rule above would then
  need a reason to bend, and the website's rule for blocks the same reason.
- **Tokens leak in practice**: binding a token to a key the device holds, rather
  than to the bearer.

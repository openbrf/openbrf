---
"@openbrf/api": minor
---

The host now holds a plugin's resident routes (ADR 0051) to the rules below. A
resident without a board seat can call a route a plugin declares under
`residentRoutes`, although the plugin reads the register, once the board has
consented to the route with the install.

- **The floor, per route.** A route is held to `self:manage` instead of the
  plugin's address-book floor only when every path it is mounted on lies under
  a resident route: the path's segments, as deep as the resident route goes,
  must be plain text equal to the route's. A parameter or a wildcard at that
  depth keeps the full floor. A route's own required capabilities still apply,
  and so does the finance half of an extension group's floor (ADR 0052). Any
  other route of the same plugin, on the same controller too, keeps the full
  floor.
- **Only a listed caller.** The application's guard lets a resident route
  answer only a person the address book lists to the plugin. Anybody else is
  refused with a 403 and the reason `resident-route-not-listed` before any of
  the plugin's code runs: the property manager, a former resident, a board
  member or administrator who does not live in the house, and a resident with
  protected personal data, under a restriction or objecting to the plugin.
- **No plugin code around the handler.** A plugin is refused at load when a
  resident route's handler has a guard, an interceptor, a pipe (a parameter's
  included), an exception filter, or a custom parameter decorator of the
  plugin's, named on the handler or its controller, or inherited from a base
  class. So is a handler that takes the response through `@Res` or `@Next`.
  The framework's other parameter decorators, such as `@Body`, `@Param`,
  `@Query` and `@Req`, stay.
- **What the route can reach.** While a resident route's request is served,
  and for work the handler leaves running, `addressBook.residents`,
  `apartments` and `summary` are refused with `PluginResidentRouteError`.
  `addressBook.caller`, `actions.list`, `invoke` and `propose`, and the actor of
  `audit.record` accept only the request the route is serving, so a board
  member's request a plugin kept in a singleton is refused. A record written
  under a new key may name only the caller. A record written over a live one
  may keep the person that record names, or name the caller. An audit entry's
  subject and a disclosure's subjects may name the caller, or a person the
  plugin already holds a readable record about, and nobody else.
- **An answer, not a stream.** A resident route's handler that returns an
  Observable, a `StreamableFile`, a stream or a `Response`, or an async handler
  that resolves to one, fails with a 502 and the reason
  `plugin-handler-failed` before anything subscribes to it or reads from it.
  NestJS and Fastify would read such an answer after the handler returned,
  outside the request's scope, where an operator on a Subject the plugin shares
  runs whenever a job or another request emits.
- **The answer as data.** Any other answer is serialized after the handler
  returns as well, and an object's `toJSON` or getter is the plugin's code. So
  the host copies the answer as the JSON it would be sent as, inside the
  request's scope, and sends the copy. The body and status of an HttpException
  the handler throws are copied the same way, and anything else it throws
  reaches the plugin error handling as a plain error with its name, code,
  message and stack copied as text. A getter that throws while the answer is
  copied counts as the handler's own throw. A failure while a thrown exception
  is copied fails the request with a 502 and the reason
  `plugin-handler-failed`.
- **Nothing done elsewhere for it.** A listener the handler awaits, such as
  `firstValueFrom()` of that operator, runs outside the scope too. So any of
  the calls above that the plugin makes outside every resident route of its
  own, a record written with `personRecords.put`, and a disclosure naming
  persons, first wait until the plugin's resident routes that were already
  being served have answered. The wait comes before the call reads or does
  anything, the person it names included. A call from the plugin's job or
  board route then goes ahead. A listener's call cannot, because the handler
  awaiting it cannot answer first, and after five seconds it is refused with
  `PluginResidentRouteError`, with `outside` set, having read, recorded or
  dispatched nothing. The cost is that the plugin's job or board route waits
  while a resident route's handler works, and is refused when that handler
  takes longer than five seconds. The hold reaches a listener only while the
  handler awaits it. A handler that stops awaiting it, by racing it against a
  timeout for one, answers. The listener's call then goes ahead with whatever
  request it was handed, and so does the call of a listener still subscribed
  after the answer. Such work is handed outside the scope, as a job is, and
  catalog review checks that no listener or callback a resident route's
  handler sets up outlives its answer or uses a request other than its own.

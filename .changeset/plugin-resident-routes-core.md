---
"@openbrf/api": minor
---

The host now serves a plugin's resident routes (ADR 0051). A resident without
a board seat can call a route a plugin declares under `residentRoutes`,
although the plugin reads the register.

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
  class. The framework's
  own parameter decorators, such as `@Body`, `@Param`, `@Query` and `@Req`,
  stay.
- **What the route can reach.** While a resident route's request is served,
  and for work the handler leaves running, `addressBook.residents`,
  `apartments` and `summary` are refused with `PluginResidentRouteError`.
  `addressBook.caller`, `actions.list`, `invoke` and `propose`, and the actor of
  `audit.record` accept only the request the route is serving, so a board
  member's request a plugin kept in a singleton is refused. A new record about
  a person, an audit entry's subject and a disclosure's subjects may name the
  caller, or a person the plugin already holds a readable record about, and
  nobody else. An Observable the handler returns, or that an async handler
  resolves to, is subscribed inside the same scope.

The install consent screen, `openbrf plugin add` and the navigation do not show
resident routes yet, and the routes the board consented to are not recorded
with the install yet.

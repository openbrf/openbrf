---
"@openbrf/api": patch
---

A plugin whose board view declares a capability that none of the routes the
board view can call requires is now refused at load as `module-refused`, and the
server log names the capability. The host offers the board view on that
capability but does not raise the plugin's routes to it. So a plugin that
declared, say, `bookings:configure` and forgot
`RequireCapability("bookings:configure")` left the routes behind its board view
open to every resident. The check needs one route to require the capability, on
the route, on its controller or through the floor. A route under one of the
plugin's device routes or under its `oauthProtectedResource` does not count,
since the board view cannot call it, and neither does a route that answers only
HEAD or OPTIONS. Whether every route the board view calls requires it is still
the plugin author's to get right. A plugin with no routes the board view can
call is not refused.

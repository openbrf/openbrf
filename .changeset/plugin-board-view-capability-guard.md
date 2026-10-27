---
"@openbrf/api": patch
---

A plugin whose board view declares a capability that none of its routes
requires is now refused at load as `module-refused`, and the server log names
the capability. The host offers the board view on that capability but does not
raise the plugin's routes to it. So a plugin that declared, say,
`bookings:configure` and forgot `RequireCapability("bookings:configure")` left
the routes behind its board view open to every resident. The check needs one
route to require the capability, on the route, on its controller or through the
floor. Whether every route the board view calls requires it is still the
plugin author's to get right. A plugin with no routes is not refused.

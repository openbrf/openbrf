---
"@openbrf/api": patch
---

Serve and authorize a plugin's routes as they were checked.

When the seal fixes a plugin controller's instance, it now also keeps each
route it checked: the paths the router mounts it on, the request methods it
answers, and the capabilities a request to it needs. A request reaches a
plugin's controller only on a route kept for it, on one of those paths and
with one of those methods. Any other request answers as though the plugin were
not installed. The authorization guard authorizes a request on a checked route
by what the seal kept, so the route is never public and needs the capabilities
it was checked with.

A checked controller's instance also takes no new properties and keeps its
prototype, and its class's own prototype is frozen. A plugin controller that
adds a property to itself after it is built, rather than giving the field a
value in its constructor or its declaration, now throws when it does so.
Plugins that declare their routes with NestJS's decorators, as the plugin
contract describes, are otherwise not affected.

---
"@openbrf/api": patch
---

Serve a plugin's controllers only on the routes they were checked with.

The guard that answers a disabled plugin's routes as not installed now also
lets a request reach a plugin's controller only through a route the seal
checked, with the method it fixed on the controller's instance. Any other
method NestJS mounts for a plugin's controller answers as though the plugin
were not installed. The guard takes the plugin from what the seal kept rather
than from the controller's metadata. Plugins that declare their routes with
NestJS's decorators, as the plugin contract describes, are not affected.

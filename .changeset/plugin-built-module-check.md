---
"@openbrf/api": patch
---

Check each plugin controller as NestJS built it.

The check on a plugin's built module now covers its controllers' instances as
well as its modules, because NestJS serves the object it built rather than the
class the seal read. A plugin is refused when one of its controllers is built
for each request or each injection (request-scoped, transient, or depending on
something request-scoped), when a controller is built into something other
than a plain instance of the class that was sealed, or when the instance holds
a property of its own under a name its class's prototype chain holds. The
Plugins screen reports it as refused rather than run (the API reports the
reason as `module-refused`), and the rest of the instance starts without it,
as with any other refused plugin.

---
"@openbrf/api": patch
---

Check a plugin's module again once NestJS has built it.

The module seal reads a plugin's classes, and some of what NestJS later uses
is decided by the objects their constructors build. The host now checks those
objects before the application starts. A plugin is refused when a module it
brings registers middleware from its instance, when one of its controllers is
not a singleton, when a controller instance is not a plain instance of the
class that was sealed, when a controller's class holds methods other than the
ones that were sealed, or when the modules built are not the ones that were
sealed. The check goes by what the seal recorded, and the application is
built from a copy of the plugin's module object taken when it was sealed. A
module that cannot be traced to the application or to a single plugin
refuses every plugin. The Plugins screen says that the plugin's module
declares behaviour that would act on the rest of the application and that it
was refused rather than run (the API reports the reason as `module-refused`).
The rest of the instance starts without it, as with any other refused plugin.

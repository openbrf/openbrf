---
"@openbrf/api": patch
---

Check a plugin's module again once NestJS has built it.

The module seal reads a plugin's classes, and some of what NestJS later uses
is decided by the objects their constructors build. The host now checks those
objects before the application starts. A plugin is refused, as
`module-refused` on the admin screen, when a module it brings registers
middleware from its instance, when one of its controllers is not a singleton,
or when a controller instance is not a plain instance of the class that was
sealed. The rest of the instance starts without it, as with any other refused
plugin.

---
"@openbrf/api": patch
---

Check that a plugin controller's prototype names it, and keep each route's
required permissions as the list that was checked.

The seal now refuses a plugin controller whose prototype names another class
as its constructor, as an ES5-style subclass's can, because the permission
check finds the class it reads a route's required permissions from through
that name. The same was already refused once the application was built; the
seal now refuses it before. The list of permissions a single route requires
is now written back as a compact copy of what the seal read, as the
controller's own list already was. The Plugins screen reports such a plugin
as refused rather than run (the API reports the reason as `module-refused`),
and the rest of the instance starts without it, as with any other refused
plugin.

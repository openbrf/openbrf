---
"@openbrf/api": patch
---

Fix each plugin controller instance to the methods and the class it was checked
with.

Once a plugin controller's instance passes the check on what NestJS built, it
is given its own `constructor` and its own copy of each route method the seal
read, each read-only and not configurable. Each route the seal checked then
keeps the method and the class it was checked with, whatever the plugin's code
does afterwards. A plugin whose controller instance cannot take them, such as
one its constructor made non-extensible, is refused as `module-refused`, and
the rest of the instance starts without it, as with any other refused plugin.

---
"@openbrf/api": patch
---

Fix each plugin controller to the routes and the class it was checked with.

Once a plugin controller's instance passes the check on what NestJS built, it
is given its own `constructor` and its own copy of each route method the seal
read, each read-only and not configurable. The routes the router mounts and the
class the application's guards see then stay the ones that were checked,
whatever the plugin's code does afterwards. A plugin whose controller instance
cannot take them, such as one its constructor made non-extensible, is refused
as `module-refused`, and the rest of the instance starts without it, as with
any other refused plugin.

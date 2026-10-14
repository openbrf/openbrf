---
"@openbrf/api": patch
---

Harden the plugin module seal further.

- A plugin controller's paths and required capabilities, on the class and on
  each route, must be plain arrays where they are lists. A plugin that gives
  them any other way is refused with `module-refused`. The capability list the
  seal writes onto the controller is now always its own copy.
- A module class, provider or controller given as a proxy is refused with
  `module-refused`, and the log line says so.
- The class, method and path names the seal writes to the log are read
  without running the plugin's code and kept to one line, as an error's name
  already was. The paths the boot log repeats for a served controller are
  escaped onto one line and bounded the same way.

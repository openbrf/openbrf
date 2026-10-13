---
"@openbrf/api": patch
---

Harden the plugin module seal further.

- The lists and declarations the seal reads of a plugin's module are frozen
  as they are read, and a dynamic module's lists are fixed to it, so what the
  seal checked is what NestJS builds.
- What the seal reads of a plugin's classes is read again at the end of the
  seal, before the application is built and once it is built, and compared
  with what the seal first read of them. A plugin whose module no longer
  reads as it was checked is refused with `module-refused`.

Plugins declared in the usual way load unchanged.

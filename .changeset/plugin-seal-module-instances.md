---
"@openbrf/api": patch
---

Harden the plugin module seal. Plugin modules are validated more strictly;
a module that fails is refused as before, and plugins declared in the usual
way load unchanged.

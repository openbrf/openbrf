---
"@openbrf/api": patch
---

Harden the plugin module seal.

- The seal checks what a plugin's module class is constructed with, and the
  guards, interceptors, pipes and filters any of its provider classes name, as
  it already did for controllers. A plugin whose module class or provider
  reaches a service a plugin may not hold is refused with
  `forbidden-injection`.
- The seal reads a module's metadata as NestJS does, and refuses metadata it
  cannot read in full. Modules and classes declared with NestJS's decorators
  are unaffected.

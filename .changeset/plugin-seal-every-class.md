---
"@openbrf/api": patch
---

Harden the plugin module seal.

- The seal checks what a plugin's module class is constructed with, and the
  guards, interceptors, pipes and filters any of its provider classes name, as
  it already did for controllers. A plugin whose module class or provider
  reaches a service a plugin may not hold is refused with
  `forbidden-injection`.
- The seal refuses a plugin module whose metadata or declarations it cannot
  read in full. Modules declared with NestJS's decorators are unaffected.
- A plugin whose module the seal cannot finish reading is refused with
  `module-refused` rather than failing the boot.

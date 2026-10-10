---
"@openbrf/api": patch
---

Harden the plugin module seal.

- The seal checks what a plugin's module class is constructed with, and the
  guards, interceptors, pipes and filters any of its provider classes name, as
  it already did for controllers. A plugin whose module class or provider
  reaches a service a plugin may not hold is refused with
  `forbidden-injection`.
- Injection metadata is read the way NestJS reads it, including entries a
  decorator would not write: a self-declared parameter whose index is a string,
  and a parameter pipe given as one class. Metadata NestJS would iterate but
  that is not an array is refused.

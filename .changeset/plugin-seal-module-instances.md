---
"@openbrf/api": patch
---

Harden the plugin module seal.

- A plugin's module instances are checked once the application is built. A
  module whose instance registers middleware, from its constructor or a field,
  is refused with `module-refused`, and the application is built again
  without it, as for a module that cannot be built.
- A forward reference in a module's imports is frozen once the seal has
  fixed it, and checked again.
- A forward reference that holds another reference's fixed value is fixed in
  turn.

---
"@openbrf/api": patch
---

The plugin module seal again builds a dynamic module that lists a forward
reference in its `imports`. The seal now closes that list to new entries when
it reads it, writes the resolved modules into it, and only then freezes it. A
plugin whose code changes an entry of that list in between is refused with
`module-refused`.

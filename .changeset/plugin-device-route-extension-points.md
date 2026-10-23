---
"@openbrf/plugin-sdk": patch
---

Refuse an extension point that accepts `email` or `phone` on a plugin that
declares device routes (ADR 0030).

A device token reaches a plugin's routes, and a device is a screen on a wall, so
a point that accepted contact details would let it reach them through an addon.
The manifest is refused with the point's `personalData` named, and the catalog
refuses an index entry that declares the same. A package skipped for it is
reported under the rule `device-route-extension-point-contact`, which the
interface reads in the board's language. A plugin without device routes, or with
points that accept other categories, is read as before.

---
"@openbrf/plugin-sdk": patch
"@openbrf/api": patch
"@openbrf/web": patch
"@openbrf/i18n": patch
"@openbrf/shared": patch
---

A plugin that declares a device route or a website block is now kept away from
every permission that reads the register, including one added later: each
permission is classified as reading it or not, and both rules follow the
classification instead of a list of the refused.

When a package is skipped because a device route or a website block sits beside
a permission that reads the register, or because a device route overlaps the
OAuth protected resource, the admin screen now words the reason in Swedish
instead of showing the schema's English line.

---
"@openbrf/plugin-sdk": patch
"@openbrf/api": patch
---

Refuse the addon that joins two clean host plugins, not the addons serving them.

Where the plugins joined by extensions would hold both a plugin that asks for
`site:blocks` and one that reads the register or proposes imports, the website
addons and then the addons that read the register or propose imports now give
way only among their own host plugin and the addons that extend it alone. Then,
across the whole group, the addons that join two of its plugins give way. Before,
installing an addon that extended both a host plugin with a website addon and a
host plugin with an addon that reads the register refused all three addons;
now the loader refuses only the addon that joins them, with
`extension-group-refused`, and the catalog likewise names it in a refused index.
Host plugins are still never refused, and the result still does not depend on
the order in which the packages are found.

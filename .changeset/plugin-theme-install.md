---
"@openbrf/plugin-sdk": minor
"@openbrf/api": minor
"@openbrf/web": minor
"@openbrf/i18n": minor
---

Let a plugin install themes (ADR 0046). A plugin asking for the new
`themes:install` permission, which the install consent screen shows, hands a
theme package and its sha512 to `host.themes.install`, with the request its own
route received. The core checks the digest before anything is unpacked and then
admits the package exactly as it admits one from the catalog: the same install
lint, the statutory register contrast included, the same staged write and the
same lock per theme id. It installs as the person behind the request, who must
hold `association:manage`; a request a connected app's token reached is refused.

A plugin installs over a theme it installed itself and over nothing else, and
`host.themes.list` returns those themes with their versions. The catalog does
not install over a plugin's theme (`theme-from-plugin`) and the composer does
not edit it. Previewing, activating and removing stay on the theme screen,
which now names the plugin that installed a theme and says why a catalog entry
under the same id cannot be installed. A theme stays installed when its plugin
is removed. The installed theme row records the plugin in a new
`installedByPluginId` column; the audit entry is on the plugin channel and names
the plugin and the person.

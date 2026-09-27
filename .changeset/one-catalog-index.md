---
"@openbrf/api": minor
"@openbrf/web": patch
"@openbrf/i18n": patch
---

Read themes from the same catalog index plugins are read from.

One index lists plugins and themes alike, in the format the plugin contract
documents. The theme screen reads it through the same client as the plugin
screen: the curated catalog when none is configured, the refusal of any other
index unless the instance has opted out of curation, https only for a curated
instance, and the digest checked before a package is unpacked. A theme's name
and description in the catalog are shown in the viewer's language.

An index in the earlier theme-only shape is no longer read. An index that lists
the same id twice is refused as a whole.

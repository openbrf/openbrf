---
"@openbrf/api": patch
"@openbrf/plugin-sdk": patch
---

When a plugin's new version turns a settings field from `text` into `secret`,
the value the board saved while it was plain is now removed from the stored
settings the next time the plugin starts serving. Until now it stayed there,
unencrypted, until the settings form was saved again, although neither the
plugin nor the admin screen ever read it. The field is unset until the board
enters it again, as before. A plugin that is switched off or not loaded keeps
its stored settings as they were.

A recipient's origin in a manifest no longer accepts an IP address, `localhost`
or a host name with a trailing dot: the consent screen names a party the board
can recognise, and the same host has one spelling.

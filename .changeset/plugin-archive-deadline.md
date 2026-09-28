---
"@openbrf/api": patch
---

Give up on a plugin tarball download that takes longer than five minutes.

A release host that sent its headers and then stopped sending held the plugin
install job, or the reinstall at boot (`OPENBRF_PLUGINS_REINSTALL_ON_BOOT`),
indefinitely, and every later install waited behind it. The download is now
abandoned after five minutes, redirects and body included. The plugin is marked
as failed with the reason, the installed plugins are left as they were, and the
next run tries again. The catalog index and theme packages already had a
deadline of 30 seconds.

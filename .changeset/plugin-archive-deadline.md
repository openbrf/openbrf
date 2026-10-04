---
"@openbrf/api": patch
---

Give up on plugin tarball downloads that take too long.

A release host that sent its headers and then stopped sending held the plugin
install job, or the reinstall at boot (`OPENBRF_PLUGINS_REINSTALL_ON_BOOT`),
indefinitely, and every later install waited behind it. One download is now
abandoned after five minutes, redirects and body included, and all of a run's
downloads together after eight. The first download that fails ends the
fetching: that plugin is marked as failed with the reason, the plugins not yet
fetched keep their status, the installed plugins are left as they were, and
the next run tries again. The catalog index and theme packages already had a
deadline of 30 seconds.

The plugin install job now allows itself 30 minutes before the queue gives up
on it, rather than the queue's default 15, so a run that waited for another run
and then downloaded and installed is not started a second time beside itself.

---
"@openbrf/plugin-sdk": minor
"@openbrf/api": minor
"@openbrf/web": minor
---

Add the plugin system: manifest, loader, permissions-scoped SDK, catalog
installation with a consent step, runtime-loaded views, and the `openbrf`
command-line tool.

A plugin is installed from the curated catalog as a tarball verified by its
sha512, and the board sees what it may do and which personal data it will
handle before agreeing to it. Installed plugins contribute HTTP routes served
inside the application's own authorization guard, a React view loaded at
runtime without rebuilding the application, background work on namespaced
queues, and a settings form the host renders from their declaration. Their
Swedish and English strings are merged at runtime under a namespace of their
own.

A malformed or refused plugin is skipped and reported rather than allowed to
stop the instance, and the install flow is idempotent: the database holds what
should be installed and the data volume is reconciled to it.

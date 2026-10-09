---
"@openbrf/api": patch
"@openbrf/web": patch
"@openbrf/i18n": patch
---

Installing and uninstalling a plugin or theme of the same id no longer race.

Two administrators acting on one id at the same moment could let an install
read the package as installed while the uninstall was removing it. A deprecated
entry, which may be installed again only where it is already installed, could
then be installed afresh over what had just been removed. Install and uninstall
of one plugin, and install, compose and uninstall of one theme, now take a lock
for that id and run one after the other, the install gates included. Different
ids, and a plugin and a theme sharing an id, do not wait for each other.

A change that waits too long for another one on the same id, or arrives while
the instance already runs four such changes, is answered 429 with the reason
`package-busy` and a `Retry-After`, and the plugin and theme screens say to try
again in a moment. A change whose database lock is lost part way stops before
its next write and is answered 503 with the reason `package-lock-lost`. Each
lock holds a database connection of its own, so the runtime role's connection
limit is now four higher: nineteen at the default pool size.

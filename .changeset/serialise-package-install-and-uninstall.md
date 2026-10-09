---
"@openbrf/api": patch
---

Installing and uninstalling a plugin or theme of the same id no longer race.

Two administrators acting on one id at the same moment could let an install
read the package as installed while the uninstall was removing it. A deprecated
entry, which may be installed again only where it is already installed, could
then be installed afresh over what had just been removed. Install and uninstall
of one plugin, and install, compose and uninstall of one theme, now take a
database lock for that id and run one after the other, the install gates
included. Different ids, and a plugin and a theme sharing an id, do not wait for
each other.

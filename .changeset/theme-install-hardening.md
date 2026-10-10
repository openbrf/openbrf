---
"@openbrf/api": patch
"@openbrf/web": patch
"@openbrf/i18n": patch
---

Harden installing, activating and removing themes.

- A catalog install no longer replaces a theme composed on the instance under
  the same id (`theme-composed`, 409); the themes screen says why.
- Activating, removing and installing a theme check the other themes under one
  lock in the transaction that writes, and a removal writes `THEME_REMOVED`.
- A theme's previous version is kept until its install has committed, and
  undoing a failed install or removal never touches the files of a later
  install of the same id.
- Theme asset URLs carry the package's checksum, so an upgrade is not served
  stale, and the compose route holds token names to `[a-z0-9-]`.

---
"@openbrf/api": minor
"@openbrf/web": minor
"@openbrf/i18n": minor
---

A plugin or theme the catalog has deprecated can no longer be installed anew.

The catalog marks an entry `deprecated` when its curator withdraws it without
delisting it. Until now that only put "No longer maintained" beside the entry,
and the install went ahead as before. A first install of a deprecated entry is
now refused with the reason `entry-deprecated` before anything is downloaded or
recorded, and both screens disable its install button.

An instance that already has the plugin or theme can still install it again and
take its updates, so a board is never left unable to repair something it
already runs.

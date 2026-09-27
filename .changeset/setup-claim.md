---
"@openbrf/api": minor
"@openbrf/web": minor
"@openbrf/i18n": minor
---

Require the setup link to claim a fresh instance. Until now the first visitor
to reach the setup wizard became the administrator. An instance now prints a
setup link to its log when it starts unclaimed, or takes the link's digest from
the environment where its host has provisioned one, and the wizard creates the
first administrator only for whoever holds it. The link stops working once the
instance is claimed or restarted, and the log says so.

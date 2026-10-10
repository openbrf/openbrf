---
"@openbrf/api": patch
"@openbrf/web": patch
"@openbrf/i18n": patch
---

Harden how plugins are sealed, installed and switched.

- The module seal also checks what a plugin's controllers, the guards,
  interceptors, pipes and filters they name, and `@Inject()` fields are
  constructed with, and matches a class by every name on its prototype chain.
- A plugin is loaded only from the directory npm installed the consented
  package into, so two packages under one id never both load. A plugin refused
  after its factory ran stops being served.
- `host.jobs` works: plugin queues are named `plugin/<id>/<name>`.
- A plugin action's `deprecatedAliases` are composed under the plugin's id.
- A reconcile records its outcome only on the releases it read, leaves the
  rows alone when another run took the installation over, and does not restart
  the process after a run that failed and changed nothing. Each archive's
  `openbrf.id` is checked before npm runs, and npm is given no git.
- Installing and removing a plugin commit their rows, the art. 30 record, the
  recipient's art. 28 classification and the audit entries together; a removed
  plugin stops being served at once.

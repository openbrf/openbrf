---
"@openbrf/api": patch
"@openbrf/web": patch
"@openbrf/i18n": patch
---

Run one member list import at a time.

Applying an import is now refused with `another-import-running` (409) while
another import session is queued or applying. The upload asked about stays in
the mapping step with its preview, so it can be applied once the other import
has finished. Two imports running side by side would each plan against a
register the other was writing, and a person listed in both files could be
created twice with a member register entry each, which can only be answered
with a correction entry.

The check and the claim run in one transaction behind an advisory lock, so two
imports of two different files applied at the same moment cannot both start.

The import screen shows the refusal in the interface's own words and keeps the
preview on screen.

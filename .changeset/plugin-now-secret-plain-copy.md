---
"@openbrf/api": patch
---

When a plugin upgrade turns a settings field from plain text into a secret, the
value saved before is now removed from the stored settings when the new version
starts, instead of staying unencrypted until the board next saves the form. The
removal is recorded in the audit log with the name of the field and not its
value. The board enters the secret again, as before.

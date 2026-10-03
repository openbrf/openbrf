---
"@openbrf/web": patch
"@openbrf/i18n": patch
---

In the apartment register, a lien release the register holds but the screen
could not read back is no longer shown as if nothing happened. The release is
reported as recorded and the screen offers to read the register again, instead
of closing the form and offering the same release a second time.

The release controls are named by the creditor, the day the lien was noted and
its amount, so two open liens from one creditor are no longer two buttons with
the same name.

---
"@openbrf/web": patch
"@openbrf/i18n": patch
---

When the settings could not be read, the settings screen still showed the housing cooperative, address and apartment panels as editable, with blank fields, and pointed an administrator back to the setup wizard. Saving the blank cooperative form would clear the stored organisation number and reset the default language.

The screen now shows only the read failure with a retry button until a read succeeds, and the setup notice appears only when a read has actually said setup is unfinished.

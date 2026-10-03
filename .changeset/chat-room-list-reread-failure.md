---
"@openbrf/web": patch
"@openbrf/i18n": patch
---

When the chat could not read its list of rooms again after a group was made or left, the whole chat was replaced by an error screen that asked for a page reload. The rooms now stay on screen, and a notice beside them says the list could not be read again, with a retry.

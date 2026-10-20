---
"@openbrf/plugin-sdk": minor
"@openbrf/api": minor
"@openbrf/web": minor
"@openbrf/i18n": minor
---

A plugin can now say where it connects to outside the instance, and keep an API
key or a token as a secret setting.

- **Recipients.** A manifest's `recipients` names each `https` origin the plugin
  connects to, what for, in Swedish and English, and which of its personal data
  categories each one receives. The install consent screen lists them, and where
  one receives personal data it fills in "yes" and the recipient in the question
  about where the plugin sends personal data. The board still says whether the
  recipient is a processor or an independent controller. A republished version
  that adds a recipient, moves one or sends one more category does not load until
  the board consents again (`recipients-widened`). The catalog entry carries the
  field in index version 2, which an instance now reads beside version 1.
- **Secret settings.** A settings field of type `secret` is never sent to the
  browser: the form says whether a value is stored, and a value is replaced or
  removed, never shown. It is stored encrypted, bound to the plugin and the key,
  and handed in clear only to the plugin through `host.settings.read()`.
  `host.settings.writeSecret()` lets a plugin replace its own secret, such as an
  OAuth refresh token. Every change is in the audit log by key, never by value.

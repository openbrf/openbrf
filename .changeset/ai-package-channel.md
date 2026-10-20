---
"@openbrf/plugin-sdk": minor
"@openbrf/api": minor
"@openbrf/web": minor
"@openbrf/i18n": minor
---

A plugin can declare that it is an AI package, `ai: true` in its manifest,
when a language model chooses the actions it dispatches (ADR 0038). What it
changes for a signed-in person is recorded in the audit log on the `ai`
channel rather than as any plugin's. It reaches only the actions offered on
the `ai` surface, and a plugin's action, its own included, only once an
administrator has armed it. A connected app's token on its route is still
recorded as the connected app. The plugin cannot choose its channel: the
host derives it from the manifest and from how the request arrived, as the
authorization guard established it, so writing a token onto the request, or
removing or changing one, moves no plugin's dispatch onto another channel.

The catalog entry repeats the declaration. The consent screen and the
command-line install state it, and an install whose screen showed otherwise
is refused. The board's consent is recorded, on the install row and on its
`PLUGIN_INSTALLED` audit entry, and a package whose manifest
says otherwise is not loaded and is listed as `ai-changed`. No core action is
offered on `ai` yet.

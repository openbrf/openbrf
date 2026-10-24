---
"@openbrf/plugin-sdk": minor
"@openbrf/api": minor
---

A plugin can now read who the instance is from `host.instance.read()`: the
association's name, as the board wrote it in the settings, and the instance's
public origin from the operator's configuration. A plugin that introduces the
instance to a screen or a service outside no longer has to ask the board for
either, or trust the headers of a request. It needs no permission, since
neither value is personal data and both are public already. The SDK types
`instance` as optional, so a plugin checks for it before use: an older instance
does not have it.

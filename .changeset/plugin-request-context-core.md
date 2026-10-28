---
"@openbrf/api": minor
---

**A change to the plugin contract.** A plugin may now use a request only in
the work that serves it, on every route (ADR 0051, update of 2026-10-28). The
host serves each request in an async context of its own, opened before the
first guard. The context covers the plugin's guard, its handler and whatever
the handler awaits or leaves running, its exception filter, and the
serializing of the answer. A host member given a request refuses it with
`PluginRequestContextError` unless the call is made in that context, before it
reads or does anything. The members are `addressBook.caller`, `actions.list`,
`invoke`, `propose` and `client`, `audit.record` with a request,
`themes.install`, and `devices.issue`, `revoke` with a request, and `current`.
On a resident route, `addressBook.caller`, `actions.list`, `invoke` and
`propose`, and `audit.record` still refuse with `PluginResidentRouteError`, and
the other members refuse with `PluginRequestContextError` there too.

A plugin that keeps a request in a singleton for "the current request", or
hands one to a job, a timer, a queue it started at boot, or a listener on a
Subject or an emitter it shares, is refused there. Such a listener runs in the
context of whoever emits, a job or another person's request. Before this, a
kept request was refused only once its response had been sent, so a board
member's request still being served could be used from elsewhere with their
capabilities. That included a listener that a resident route's handler had
stopped awaiting when it answered. A plugin that does this takes what the work
needs from the request while it serves it, such as an id or the answer of
`caller`, and passes that on. The example plugin passes no request to the host,
and the catalog lists no plugin, so neither changes. The contract version stays
`1`, although a plugin can notice the change. ADR 0020 now allows this for a
security fix that only refuses a use of the host beyond what the contract
grants, where raising the version would refuse to load every plugin built
against it.

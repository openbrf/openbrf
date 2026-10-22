---
"@openbrf/api": minor
"@openbrf/web": minor
"@openbrf/i18n": minor
"@openbrf/shared": minor
"@openbrf/plugin-sdk": minor
---

Add pending changes: a call to an action held as a preview until the person it
was proposed as confirms or rejects it on a screen of the platform's own, at
`/app/pending-changes`. A plugin proposes one with `host.actions.propose`, which
checks the call as `invoke` would and runs nothing; confirming runs it as the
person confirming, with what they may do at that moment, and every check made
again, including the arming of a plugin's action proposed through a connected
app. A change is claimed before its action runs, so it never runs twice. Only the
proposer can see or act on a change, and it lapses after a week.
A write on the `ai` channel is refused with `confirmation-required` and has to be
proposed. Proposing, confirming, rejecting and expiry are each recorded in the
audit log, and the entry of the action the change held names the pending change;
a write that action makes through `host.actions.invoke` is the plugin's own and
does not. See ADR 0039.

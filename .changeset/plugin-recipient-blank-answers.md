---
"@openbrf/api": patch
---

Read an empty field in a plugin install's answer about where the plugin sends
personal data as no answer. Also keep an agreement's own details off a recipient
that is not a processor.

- An empty other party no longer hides the recipient the board named, so an
  independent controller is recorded under that name. An empty recipient
  likewise no longer hides the other party.
- An empty note on a plugin that sends nothing outside is no longer refused as
  a missing reason. The instance's own reason, that the plugin runs in its own
  process, is recorded in its place.
- For an independent controller, the date the agreement was signed, its
  reference and its note on sub-processors are no longer recorded among the
  processor agreements. They describe the contract GDPR art. 28(3) requires of
  a processor, and an independent controller has none.

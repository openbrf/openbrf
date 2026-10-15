---
"@openbrf/api": patch
---

A thread in the board mailbox whose sender's domain contains characters that cannot appear in a hostname (for example a space, a slash or a control character) is no longer converted to punycode. The panel now shows its warning that the domain cannot be converted, instead of a converted domain that a reply would not go to.

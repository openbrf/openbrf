---
"@openbrf/api": patch
"@openbrf/web": patch
"@openbrf/i18n": patch
---

A thread in the board mailbox whose sender's domain is written with letters outside A-Z now shows the domain the way a reply will address it (punycode), so a lookalike such as a Cyrillic "е" in place of a Latin "e" can be told apart before the board answers. A domain whose label mixes alphabets also carries a warning. A legitimate international domain such as `münchen.de` or `почта.рф` is shown with its punycode form and no warning, and the address itself is not changed.

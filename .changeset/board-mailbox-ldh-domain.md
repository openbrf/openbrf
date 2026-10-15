---
"@openbrf/api": patch
---

A thread in the board mailbox whose sender's domain holds a character that Unicode maps to a delimiter (a fullwidth comma, a parenthesised digit, a small comma) is no longer converted to punycode: the panel shows its warning that the domain cannot be converted, instead of a domain with a comma in it. Characters that are drawn as nothing, such as the combining grapheme joiner, the Khmer inherent vowels and the shorthand format controls, are now removed from names and refused in addresses, as the other invisible characters already were.

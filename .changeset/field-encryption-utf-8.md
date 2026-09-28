---
"@openbrf/api": patch
---

Keep å, ä, ö and every other non-ASCII letter in an encrypted field.

Field encryption handed the value to CipherSweet as a string, which the library
turns into bytes as latin1, while decryption read the bytes back as UTF-8. Any
letter outside ASCII came back as U+FFFD: in an uploaded member list held
between the import's steps, and in encrypted names and addresses such as an
issue reporter's or a board mailbox correspondent's. Values are now encrypted
as UTF-8. A value stored before this change is still read correctly when it
holds nothing above U+00FF, which covers the Swedish letters; a letter above
that was cut to a single byte when it was stored and cannot be recovered.
Blind indexes are computed as before, so existing search results do not move.

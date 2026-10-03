---
"@openbrf/api": patch
---

Keep å, ä, ö and every other non-ASCII letter in an encrypted field.

Field encryption handed the value to CipherSweet as a string, which the library
turns into bytes as latin1, while decryption read the bytes back as UTF-8. Any
letter outside ASCII came back as U+FFFD: in an uploaded member list held
between the import's steps, and in encrypted names and addresses such as an
issue reporter's or a board mailbox correspondent's. Values are now encrypted
as UTF-8, and the ciphertext records that in its authenticated associated data,
so a value is never read in the wrong format: a value stored before this change
is read as it always was, as latin1, and a new one as UTF-8, with no guessing
from the bytes. Nothing has to be migrated, and the column format is unchanged, but a value
written by this release cannot be read by an older one.
An older value reads back as entered when it holds nothing above U+00FF, which
covers the Swedish letters; a letter above that was cut to a single byte when
it was stored and cannot be recovered. Blind indexes are computed as before, so
existing search results do not move.

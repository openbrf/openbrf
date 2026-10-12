---
"@openbrf/web": patch
"@openbrf/api": patch
"@openbrf/i18n": patch
---

A protection change on a person that got no answer (offline, a timeout) is now read back, so the panel shows what the register holds instead of an unmasked person who may already be protected. A lien release that got no answer or a server error is read back too, and reported as recorded when the register shows it, rather than as a refusal that sends the board to release again; when the register cannot be read either, it is reported as not known, with a retry of the read. A protection change whose read-back fails too leaves a notice and a retry on the panel. A chat room that cannot be read now says the chat could not be read, not that something could not be saved. Liens in the apartment register extract are listed in a fixed order when two share a day, so "entry n of m" names the same row after every read.

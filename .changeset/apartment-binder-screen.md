---
"@openbrf/web": minor
"@openbrf/i18n": minor
---

The apartment binder has a screen: a household reads its own home's papers, and
a board member reads any of them.

The binder landed as a schema and an API with nothing to open it. This is the
route, under Lägenhetspärm in the band, offered to everybody who lives in the
building and to whoever holds a board seat - and to nobody else, on the document
archive's rule: an external property manager handles the association's issues
and a household's papers are not theirs to browse.

One route with two halves, because they are two ways of reaching the same thing.
Above, the binder of whoever is reading: one section per apartment their
residency is in force on, the entries grouped by kind, each row carrying its
title, its day in the data face, the file's name and size, and a sign saying who
it is for. Below, and only with a board seat, a chooser over every apartment in
the association and the binder it opens. Nothing is chosen for them, because
choosing is the act that discloses a household's papers and the act the server
writes to the audit log.

A household is shown no name at all. A row says the board, a tenant-owner, or
you, and the answer the screen is given carries nothing else - so there is no
name to leak and no branch deciding whether to show one. The board's half is the
place names appear, beside the two counts that say how many people read the
binder today, which is what lets a board see that a household it believes has
left still reads it.

Filing is the tenant-owner's, and the form says what it is doing: what is left
stays with the apartment and is read by whoever lives there next. It offers the
five kinds a household may file and not the board's alteration permission, which
the board's own form offers with the day of the decision required. Taking an
entry out is offered on what this account filed and on nothing else.

A refusal stands with the control that caused it, and says which field was
wrong. A title and a file name are both checked for a personal identity number,
and a person told only that "the filing" carries one would retype the title, be
refused again, and have learnt nothing: the sentence names the title or the file
name, and never the number the scan found. The form also says plainly that
nothing opens the file itself, which is the honest version of a guarantee the
platform cannot give.

The move-out panel gains one line for the board member ending a residency: the
binder follows the apartment, the person moving in reads it from their
move-in day, and anybody else living there reads it until they are moved out
too.

The document archive's file picker gains a focus ring with it. Its input is
visually hidden and is what the keyboard reaches, and the label drawn in its
place had no focus style of its own, so nothing on the screen moved when the
control was focused. The binder's own picker was built the same way and is
drawn the same way now: the label sits after the input, where a focus ring and
a disabled state both reach it.

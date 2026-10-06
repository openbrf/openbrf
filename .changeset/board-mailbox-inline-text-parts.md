---
"@openbrf/api": patch
---

Show the board all the text of a letter written in several text parts.

Some mail clients write a letter as more than one text part. Apple Mail, for
one, puts the text before an inline picture in one part and the text after it
in another. The board's mailbox read only the first, so the board saw the
letter up to the picture, and nothing on the screen said that more followed.
Every text part a mail client shows is now read, in order, with a blank line
where a picture or file stood between them. The whole is held to the same
length as one letter, and a letter cut at that length is shown as cut.

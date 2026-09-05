---
"@openbrf/web": patch
---

Render the data subject access report in the subject's language.

The document is printed and handed to the person it is about, and it was
rendering in the language of whoever produced it: a board member reading English
printed somebody a data subject access report (registerutdrag) in English. The
person's preferred locale is on the document already, is what every mail and
message the server sends is rendered through, and is now what the document
itself is rendered through.

The screen around the document stays in the reader's language - the heading, the
two buttons and anything said about the fetch are addressed to the board member,
not to the subject. The document also declares its own language, so anything
that speaks a printed page reads it out in the language it is written in.

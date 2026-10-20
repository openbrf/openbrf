---
"@openbrf/api": minor
"@openbrf/i18n": minor
---

A connected app can read the association's document archive for the person
who connected it. `document_list` lists the documents that person may read,
with search on the title and the binder. `document_get` reads the text of up to
ten pages of one document's PDF. Both follow the archive's own rule: the public
shelf for anyone, and the members' shelf for a member or the board. The board's
own shelf is not offered. Both are offered on `mcp` and `ai`.

The text is extracted when it is asked for and is not stored. Mozilla's pdf.js
does the extraction in a worker thread, with caps on the file size, the number
of pages, the amount of text, the time and the worker's memory. At most two
reads run at once. A scanned PDF is answered as having no text layer, and
there is no OCR.

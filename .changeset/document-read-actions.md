---
"@openbrf/api": minor
"@openbrf/i18n": minor
---

A connected app can read the association's document archive for the person
who connected it. `document_list` lists the documents that person may read,
with search on the title and the binder. `document_get` reads the text of up to
ten pages of one document's PDF, and each answer names the page and the
character the next read starts from, so a long document, or a page longer than
one answer holds, is read in turns with nothing skipped. Both follow the
archive's own rule: the public shelf for anyone, and the members' shelf for a
member or the board. The board's own shelf is not offered. Both are offered on
`mcp` and `ai`.

The text is extracted when it is asked for and is not stored. Mozilla's pdf.js
does the extraction in a separate Node process of its own, with no environment,
no file access outside pdf.js and no right to start processes or threads, under
caps on the file size, the number of pages, the amount of text, the time and the
process's memory. The API watches the process's memory, as the operating system
counts it, and stops the process that passes the cap or the time, or whose
memory it repeatedly fails to read; where the system does not report it, the
process's own watch and heap cap remain. A read whose answer from the process is
not what the API expects is refused as unreadable. At most two reads run at
once, and a read past them is refused before its file is opened.
A scanned PDF is answered as having no text layer, and there is no OCR.

---
"@openbrf/web": patch
"@openbrf/i18n": patch
---

On a page that already held the 200 blocks a page may have, a return in a paragraph or a paste of several paragraphs still made new blocks, and the server then refused the whole save. A return now starts no new paragraph there, pasted paragraphs that do not fit are joined to the paragraph being written in with nothing dropped, and the editor says why at that paragraph and beside the add buttons.

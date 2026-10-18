---
"@openbrf/api": patch
"@openbrf/web": patch
"@openbrf/i18n": patch
"@openbrf/shared": patch
---

Declare each website block type once. A block type's stored shape, strict
schema, reading, the text the publication guardrails scan and how the page
editor offers it are now one definition in `@openbrf/shared`, read by the API
and the editor alike, and the website's renderer is keyed by the same types.
Every existing block reads, saves and renders as before, and stored pages are
unchanged.

A block whose type is namespaced as a plugin's, `<plugin id>/<name>`, and that
no installed plugin defines now shows nothing on the website and is kept when
the page is saved, instead of being dropped. The page editor shows it as a
plugin's block that can be moved or removed. Its text is scanned for personal
identity numbers before the page is published. Such a block is limited to
10 000 characters of JSON and 32 levels of nesting; one over either is refused
when the page is saved. The page actions show it but do not accept it back.

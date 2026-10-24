---
"@openbrf/display": patch
---

Let a page that forbids inline styles serve the renderer's stylesheet as a
file, and run the renderer in Chromium 85. `mountRenderer` takes
`stylesheet: false` to add no `<style>` element, and also adds none when the
head already holds a `link` with the attribute `data-obrf-display`; the page
links `DISPLAY_STYLESHEET` served as a file. The renderer no longer uses
`Element.replaceChildren`, `inset` or a selector list in `:not()`, which
Chromium 85 lacks, and a test keeps them out.

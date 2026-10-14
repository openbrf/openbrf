---
"@openbrf/web": patch
"@openbrf/i18n": patch
---

A paragraph in the page editor took more than the 5000 characters the server stores, and the whole page was then refused on save with a message about links. The editor now holds a paragraph at 5000 characters: typing past it adds nothing, a paste is cut to what fits without touching the text already written, and the editor says why at the paragraph that was cut, also when a paste started it, and on a page with no room for another block it advises removing a block rather than starting a paragraph. A save the server still refuses for length says so and names the block, rather than asking about a link.

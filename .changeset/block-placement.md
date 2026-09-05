---
"@openbrf/web": minor
"@openbrf/i18n": minor
---

Let the board put the news block and the two form blocks on a page.

Three block types rendered and validated and no screen offered one, so the only
way to put a news teaser, a contact form or a report form on a page was a direct
call to the API. The page editor deliberately does not offer them: placing one
belongs to the screen that owns what it shows, and that half had never been
built.

It is built now, on all three at once, because doing one would have left the
same gap open from the other two sides. The teaser is placed from the news
editor, where how many items a page should show is a decision about what the
association publishes; the contact form from the inbox it fills; the report form
from the setting that turns public reporting on.

The block is appended to the page and the page editor is where it is then moved,
so two screens never arrange one page. A page that already carries the block is
not offered a second, and a page whose pictures need the publication
confirmation says where that confirmation is given rather than asking for it a
second time, away from the pictures it is about. The control appears only for a
board member who may write the website, which is not the same seat as the one
that reads the inbox or configures reporting.

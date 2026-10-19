---
"@openbrf/api": minor
"@openbrf/web": minor
"@openbrf/i18n": minor
"@openbrf/shared": minor
---

List the news, the calendar, the broker information page and the account
request form as built-in pages, and put them in the menu the way any page is.

The website's page list now shows the four built-in pages beside the
association's own, marked as built in. Opening one shows what stands on it,
lets the board rename it, and links to where its content is written: the news
screen, the events, or the account request setting. The broker information
page's own panel is where the association facts it is made from are recorded.
What stands on a built-in page stays the platform's, its address does not
change, and it is always public.

Adding a menu entry no longer has a separate choice for a generated page. The
built-in pages are among the pages to choose from, and an entry left without a
label takes the page's title. Every menu keeps its entries, their labels and
their places when you upgrade, and the website's addresses stay the same.

For API clients: a menu entry's `kind` is `PAGE` or `EXTERNAL`, and
`generatedKey` is gone; an entry for a built-in page is a `PAGE` entry with the
page's id. Every page carries `builtIn` (`NEWS`, `CALENDAR`,
`BROKER_INFORMATION`, `REQUEST_ACCOUNT` or `null`). A built-in page takes a new
title and nothing else: a body, another address, another status, the front
page and a delete are refused with `built-in`. The `menu_generated_keys`
action is retired; `page_list` finds the built-in pages. ADR 0027 records the
model.

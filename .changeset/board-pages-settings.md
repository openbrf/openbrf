---
"@openbrf/web": minor
"@openbrf/i18n": minor
"@openbrf/api": patch
---

Settings in the navigation are now your own account and nothing else: your
profile, your language and how you sign in, on one page at `/settings`. How the
housing cooperative is run is the board's work and has moved to the board's
section, in a new Settings group: the housing cooperative's settings, with the
same sections as before, plugins, licences and connected apps, each under
`/board` with the board's sign on its heading. The theme screens moved with
them, to `/board/themes`. Licences and themes carry the administrator's sign,
since only an administrator manages them. The board zone that marked the
association's sections on the old settings screen is gone, and with it the
last zone in the application.

The links in the emails about a message from the contact form and a broker's
update request open the account requests at their new address. The housing
cooperative's sections are no longer under `/settings`, and `/plugins`,
`/licences`, `/connected-apps` and `/admin/themes` no longer exist. Nothing
changes in who may do what.

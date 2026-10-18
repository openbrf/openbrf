---
"@openbrf/api": patch
"@openbrf/web": patch
"@openbrf/i18n": patch
---

Split the settings screen into sections, each at an address of its own:
`/app/settings/account`, `association`, `appearance`, `communication`,
`signups`, `issues-bookings`, `meetings` and `data-protection`. A list of the
sections sits beside the content from 1024px and above it on a narrower screen.
The back button moves between the sections you opened, and a section can be
linked to. `/app/settings` opens the first section you have, which is your own
account, and so does a section that does not exist or that you have nothing in.

Who sees which panel has not changed. A resident still sees only their own
profile and security, now as the one section "My account". The email that tells
the board about a message from the website's contact form now links to the
section with the inbox rather than to the top of the settings.

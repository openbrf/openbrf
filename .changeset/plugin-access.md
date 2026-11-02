---
"@openbrf/api": minor
"@openbrf/web": minor
"@openbrf/i18n": minor
"@openbrf/shared": minor
---

The board can give a person who does not live here, such as somebody who rents
a parking space, access to one plugin (ADR 0053). A plugin access is granted
and withdrawn on the person's page in the address book, by a board member who
may write the address book, and in the web interface only: no connected app,
action or AI package can grant one. Both acts are in the audit log. No
residency is created for the person. They get an account the way any person
the board adds without a residency does, through the invitation sent from
their page.

A plugin access is only for a person who has never lived here. The grant is
refused for a person with any residency on record, whether it is current, has
ended or begins later. Recording a residency ends every access the person
holds, in the same write, and that applies to a move-in, an approved account
request and a member list import. The move-in form, the preview of a member
list import and the queue of account requests say so before the board saves,
applies or approves: a request is told when the one person its email address
matches, who has no account, holds an access. An address with an account, or
one that two persons share, is refused at approval and ends nothing. An access
goes when its plugin is removed.

The person's page shows each access and the day it was granted, and the address
book gains a tab listing the persons whose only tie to the association is a
plugin access. The data subject access report lists a person's plugin accesses.

Nothing can be granted yet. An access can only be given to a plugin that
declares people given access among the callers its resident routes serve, and
whose install consented to that class. Recording that consent, and serving
these people on resident routes, arrive in a later change of this release.
Until then the grant is refused for every plugin and the page offers none.

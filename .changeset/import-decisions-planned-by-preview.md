---
"@openbrf/api": patch
"@openbrf/web": patch
---

Starting a member list import after answering rows the preview could not
resolve no longer works out the whole file again inside the request. For a long
file with personal identity numbers, checked against a register that already
holds some, that took minutes and could outlast the proxy in front of the API.

The import now starts only with the answers its preview was worked out with,
and is refused with `decisions-not-previewed` otherwise. The import screen then
takes the preview again with the answers, in the background as any preview,
and starts the import as soon as it is ready if it shows the same rows. When
the answers change what other rows match, the screen shows the new preview
first, as before.

The preview now also records where it writes every row, and each part of the
import checks its rows against that before it writes them. A row that a change
elsewhere in the register has sent to another person since the preview - an
email address moved from one person to another in the address book, say - stops
the import with `register-changed-during-apply` instead of giving that other
person the row's residency and member register entry. The parts written before
it stay written. A row the board chose to leave out does not stop the import
this way while it still needs an answer, since nothing is written for it. A
preview taken before this version is refused with
`preview-outdated`, and taking it again is enough.

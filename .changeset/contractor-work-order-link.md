---
"@openbrf/api": minor
"@openbrf/web": minor
"@openbrf/i18n": minor
"@openbrf/shared": minor
---

A contractor can be given a link to a work order, so they can answer it
without an account (ADR 0055). The link ships switched off until its legal
review is done: set `OPENBRF_CONTRACTOR_LINKS_ENABLED=true` to turn it on. With
the switch off, handlers are offered no link, work orders are mailed as
before, and links given earlier refuse; they open again if the switch is turned
back on, until they expire or end, so a handler can still withdraw one from
the work order while the switch is off.

- **The link.** On a work order that has been sent, a handler gives the
  contractor a link. Its address is shown once, and the handler sends it by
  whatever means they choose, such as a text message or their own email.
  Giving a new link stops the old one from working.
- **What the contractor sees.** The work order as the handler wrote it, the
  date it was sent, and the photographs the board chose for it. Never the
  issue, its number, the report, who reported it, the conversation, a
  handler's name or another work order.
- **What the contractor does.** Accepts or declines, writes notes, adds
  photographs and marks the work order done. Their answer, notes and
  photographs appear on the work order for the handlers, and the answer also
  appears on the issue's timeline. The assignee, or the type's handlers when
  nobody is assigned, get the usual issue notice email with no text from the
  contractor: for every answer, and at most once an hour for notes and
  photographs. The reporter never sees any of it.
- **Photographs.** Only JPEG, PNG, WebP and GIF images, identified from their
  bytes, stripped of location and camera details, at most 40 megapixels,
  stored under a name the server chooses and readable only by the issue's
  handlers. The board's photographs are shown to the contractor under such a
  name too, never under the reporter's file name. A work order takes at most 10 photographs and 30 MiB from its
  contractor.
- **When the link ends.** It ends 30 days after it was given, when the
  contractor declines or marks the work done, or when a handler withdraws it.
  It also ends when the work order's text is removed, the contractor is removed
  from the list, the issue is closed (merging it into another as a duplicate
  included) or its type is ring-fenced, or a person
  with protected personal data reported the issue or lives or is to live in
  its apartment, from the day that is recorded; clearing the protection later does not bring
  the link back. Reopening a closed issue brings no link back: the handler gives a new one. A
  link that has ended shows the same page as one that never existed, and the
  work order's record says it has ended.
- **Personal data.** The contractor's notes and photographs are part of the
  issue's free text: they are removed with it after closing and a handler can
  remove them at any time. The data subject access report says, for each work
  order, whether a link was given and how many photographs it showed.
- **Limits.** From one address, 30 page reads, 5 answers or notes and 3
  photographs a minute. For each work order, 10 notes an hour and 50 in all,
  and 5 photographs an hour.
- **Website addresses.** A new page can no longer be given the address
  `/arbetsorder` or `/work-order`. A page that already has one keeps it.
- **Operators.** Keep `/arbetsorder/` paths out of the reverse proxy's access
  log, as for `/arende/`. `docs/deployment.md` says how.

---
"@openbrf/api": minor
"@openbrf/web": minor
"@openbrf/i18n": minor
"@openbrf/shared": minor
---

A reporter who has no account can now follow their issue and answer the board
through a private link (ADR 0055).

- **The link.** When somebody reports an issue on the website's form and leaves
  an email address, they are mailed a private link to a page for that issue.
  The page shows the issue's type, where it stands, and the conversation, with
  each handler's message signed by the board or the property manager. The
  reporter writes back there, text only. Without an address there is no link
  and no follow-up.
- **What the page never shows.** No assignee, no handler's name, no internal
  note, no priority, no waiting reason, and nothing the reporter wrote on the
  form.
- **The mail.** It carries the issue's type and the link, and nothing anybody
  wrote. It is sent once per issue and never again, at most three a day to one
  address, and never to a person who restricted processing. The issues entry
  in the record of processing activities now names the mail server.
- **How long it works.** The link ends 30 days after the issue is closed, a
  year after the issue's latest message while it stays open, or when a handler
  withdraws it. A handler sees on the issue whether the reporter's link still
  works, writes to the reporter while it does, and can withdraw it. Every link
  that opens nothing gets the same page.
- **Limits.** Thirty page reads and five messages a minute from one address,
  and ten messages an hour and a hundred in all through one link.
- **Website addresses.** A new page can no longer be given the address
  `/arende` or `/case`. A page that already has one keeps it, and its contact
  and issue report forms keep working.
- **Operators.** A reverse proxy logs the full path of each request, and the
  link's path is the credential. `docs/deployment.md` says how to keep these
  paths out of the proxy's access log.

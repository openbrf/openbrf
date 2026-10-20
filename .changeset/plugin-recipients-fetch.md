---
"@openbrf/plugin-sdk": minor
"@openbrf/api": minor
"@openbrf/web": minor
"@openbrf/i18n": minor
---

A plugin can now reach the recipients it declares through the host, and every
request that carries personal data is in the audit log.

- **`host.recipients.fetch(id, path, init)`** sends one request to the origin
  of a declared recipient and nothing else. A path that would leave the origin,
  a host that resolves to a private address, and a redirect to another origin
  are refused.
- **Disclosures.** A request whose body carries personal data names the
  categories and the persons it is about. Categories the recipient is not
  declared to receive, and persons with protected personal data or under a
  restriction of processing, are refused before anything is sent. Each person
  gets an audit entry before the request leaves and one with its outcome after,
  and both are on their data subject access report.
- **The record of processing activities** lists a plugin's declared recipients
  that receive personal data. A plugin that declares none, as an entry in index
  version 1 cannot, leaves the recipients the board wrote there as they are.

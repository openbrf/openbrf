---
"@openbrf/plugin-sdk": minor
"@openbrf/api": minor
"@openbrf/web": minor
"@openbrf/i18n": minor
"@openbrf/shared": minor
---

A plugin can now read the association's fee notices and charges, record where
it delivered one, and hear when one is issued or changed, through
`host.finances`. This is the free part of advanced finances: what carries a
notice or a charge into an accounting system or a bankgiro file is a plugin's
own work, and it now has a public API to do it on.

- Reading the finances covers the fee notification runs and their notices and the
  charges to members, masked as the files the board hands over and further: a
  person with protected personal data, or whose processing is restricted, is
  never named to a plugin, and a withheld value is a `withheld` branch rather
  than an empty string. No read carries a personal identity number or any
  payment state.
- A separate permission lets a plugin record a delivery receipt - the route, the time
  and the receiving system's reference - against a notice or a charge. It is
  never a paid flag, it is audited, and the board sees receipts beside each
  notice on screen; they are not printed and not in the file. A plugin's read
  withholds a receipt's reference wherever the row's names are withheld. The
  data subject access report lists a notice's or a charge's receipts beside it.
- `host.finances.events` delivers `feeNotification.issued` and
  `memberCharge.recorded`, `corrected` and `removed`, versioned per type and
  enqueued in the same transaction as the act. An event queued when the board
  switches the plugin off is dropped, not retried.

A plugin route reading the finances requires both the fee and the member charge
management rights. The plugin consent screen names the two permissions and the
financial personal-data category a plugin reading charges declares. A manifest
may not ask to read the finances beside publishing website blocks, as it may not
ask for the address book there: a notice names the people it is for, and a
website block is published to anybody. `host.finances` is feature-detected; the
contract version stays 1. `docs/plugin-contract.md` now also says plainly that a
plugin setting is no place for a credential.

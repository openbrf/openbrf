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

- `finances:read` reads the fee notification runs and their notices and the
  charges to members, masked as the files the board hands over and further: a
  person with protected personal data, or whose processing is restricted, is
  never named to a plugin, and a withheld value is a `withheld` branch rather
  than an empty string. No read carries a personal identity number or any
  payment state.
- `finances:recordDelivery` records a delivery receipt - the route, the time
  and the receiving system's reference - against a notice or a charge. It is
  never a paid flag, it is audited, and the board sees receipts beside each
  notice on screen; they are not printed and not in the file.
- `host.finances.events` delivers `feeNotification.issued` and
  `memberCharge.recorded`, `corrected` and `removed`, versioned per type and
  enqueued in the same transaction as the act.

A plugin route reading the finances requires both `fees:manage` and
`memberCharges:manage`. The plugin consent screen names the two permissions and
the new `financial` personal-data category. `host.finances` is feature-detected;
the contract version stays 1. `docs/plugin-contract.md` now also says plainly
that a plugin setting is no place for a credential.

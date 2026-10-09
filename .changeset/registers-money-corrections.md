---
"@openbrf/api": minor
"@openbrf/web": minor
"@openbrf/i18n": minor
"@openbrf/shared": minor
---

Correct the registers, fees, charges, key orders, subletting and the member
import where they could record or report the wrong thing.

**Operators:** after upgrading an instance that recorded moves or ran a member
import before this release, run `openbrf member-register reconcile` once, read
its report, and then run it with `--apply`. It appends the member register rows
that an older register is missing and changes nothing else. See
`docs/member-register-reconciliation.md`.

Registers and moves:

- A transfer or a grant is recorded only for a tenant-owner, on both sides of
  the move, and an apartment is granted once.
- The initial supply to Lantmäteriet leaves out the holders of an apartment
  whose tenant-ownership has been terminated, takes the membership decision
  from the transfer that began the current holding, and lists apartments in a
  fixed order, as the apartment register extract now does too.
- The member register extract no longer lists an apartment against a
  membership that began on the day the apartment was left.
- Removing an address that gains an apartment at the same moment answers with
  the refusal rather than a server error.

Fees:

- A fee rate cannot be recorded from a day a notification run has already
  billed, and a rate that no run billed can be removed even when a run's period
  covers its days.
- A run is refused, rather than failing, when a notice would exceed what an
  amount can hold, when its payment references would repeat a run's from a
  century apart, or when its period is older than notices are kept for.
- A protected person living in an apartment withholds the household's names on
  the fee notice, whether or not they hold the tenant-ownership.
- Closing a fee rate stamps the financial year it ends in.

Charges, key orders and subletting:

- A correction that sends the VAT treatment again keeps the stored rate.
- A charge cannot be dated before the seven years charges are kept for.
- The debiting list export's audit entry records how many rows it held.
- A key order or a sublet application can no longer be revised once the
  applicant has moved out of the apartment.
- A sublet period may end at most five years ahead.
- Every nightly purge runs at a minute of its own.

Member import:

- The preview names each row by its row in the uploaded sheet.
- The upload's sample rows hide personal identity numbers.
- A ten-digit identity number gets its century from the whole birth date.
- Whether a residency has ended is judged on the association's calendar day.
- A quoted CSV field after a space, and a header title with a line break in
  it, are read correctly.

Every CSV file the platform writes also quotes a cell holding a comma or a tab.

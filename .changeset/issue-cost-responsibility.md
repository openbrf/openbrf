---
"@openbrf/api": minor
"@openbrf/web": minor
"@openbrf/i18n": minor
"@openbrf/shared": minor
---

Issues record who pays, a charge can be made from an issue, and the board keeps
a responsibility guide from its own bylaws (ADR 0054).

- **Who pays.** A handler records whether an issue is paid for by the
  association, by the tenant-owner, or is unclear. Any handler can, the property
  manager included. It is on the issue's timeline and in the audit log. It is
  internal like the assignee: the reporter is not shown it on the issue, but it
  is listed in their data subject access report, which lists what is held about
  them. An issue never carries an amount.
- **A charge made from an issue.** "Create a charge" on an issue opens the
  charges screen with the form filled in: the issue's apartment, or the resident
  who reported it, and a reason naming the issue's type. The board enters the
  amount there, and it is stored only on the charge. The charge names the issue
  it was made from, so removing the charge leaves the issue as it was, and an
  issue purged or merged away leaves the charge. A board member who may read
  charges sees the charges made from an issue, with their amounts, beside it.
  The property manager does not, and nothing they read about an issue carries an
  amount. The printed debiting list and its file do not name the issue. While
  the person who reported an issue has protected personal data, its charges are
  shown as withheld, and the debiting list on screen does not link those charges
  to the issue, so neither leads to who reported it. A data subject access report masks the
  issue link of a charge in the same case.
- **Responsibility guide.** The board edits a table of who maintains which part
  of the home and the building, under the association's own bylaws, in the
  settings beside the issue types. It starts from an example the board loads and
  changes, and stays labelled as an example until the board says it follows the
  bylaws. Handlers see it when they decide who pays. Whoever reports a fault sees
  it first only once the board has adopted it: a resident on the report form in
  the application, and anybody on the public website's issue report form. A
  line holding a personal identity number is refused, and the editor names the
  line and the field. A save made from a table somebody else has saved since is
  refused, and the draft is kept.
- **Notice to remedy.** Where a handler records that the cost is the
  tenant-owner's, or closes an issue as the tenant-owner's responsibility, the
  screen says that a message on the issue is not a notice to remedy
  (rättelseanmaning) under BRL 7 kap. 12 a §. That notice is sent outside Open
  BRF, in a way that shows it arrived.

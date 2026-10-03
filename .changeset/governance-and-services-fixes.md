---
"@openbrf/api": patch
"@openbrf/web": patch
"@openbrf/i18n": patch
---

Fix a batch of defects in bookings, meetings, motions, issues, actions and
events, and on the board's charges and fees screens.

Bookings:

- A booking can no longer be cancelled once it has been used. A resident
  cancels until it begins and the board until it ends, so a cancelled booking
  no longer gives the week's allowance back.
- A claim made while the board changes or withdraws the resource is refused,
  instead of landing on the old slot grid next to the new one.
- A guest-apartment stay can be a single night: choose the check-in night
  again.
- The booking panel uses resources and apartments that arrive after a failed
  first read.

Meetings and motions:

- Once a meeting has been held, its attendance lines and proxy
  authorisations can no longer be struck off. A meeting can no longer be
  recorded as held before its day.
- Checking somebody in, or registering a proxy, at the moment the meeting is
  concluded can no longer slip past the conclusion.
- A second assistant for one principal, and an assistant or proxy holder
  recorded for themselves, are refused with a reason instead of a server
  error.
- Striking off a member or proxy holder also strikes off the assistant they
  brought.
- A proxy holder registered as a member no longer votes for anybody after
  leaving the association. A proxy authorisation dated after today is
  refused.
- Erasure and retention keep a motion while the meeting it is on has not
  been held.
- A failed re-read on the motions screen keeps what the screen showed.

Issues, events and actions:

- The photo limit on an issue holds against uploads sent at once, and a
  refused upload leaves no stored file behind.
- Removing an issue type while somebody files a report, and two edits to one
  event series at once, are answered with a reason instead of a server error.
- A date in an event series that has begun can no longer be called off.
- The action catalogue leaves out plugin actions the caller would be refused.
  Looking one action up uses the same surface as the list, and a disabled
  plugin's action is answered as unknown.
- A core action holding a capability or name that no action may have is
  refused when it is registered.

Charges, fees and other forms:

- Amounts typed the Swedish way ("1 234,50") are accepted on the charges, fees
  and move screens.
- The fee aid divides by the sum of the recorded participation shares, so
  shares recorded as percentages or whole numbers give the right fees.
- Charges and fees are removed only after a confirmation, and a charge can be
  corrected on the charges screen.
- A failed read of the charge parties is reported on its own. Clearing a date
  no longer reads as a failed load.
- An accounting basis produced for dates the board has since changed is no
  longer shown.
- One fee-notice document is produced at a time. It states its period,
  production date and due date, prints, and labels the bankgiro and the
  plusgiro.
- A withdrawn sublet application or key order says the member withdrew it,
  not that the board answered it.

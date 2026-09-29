---
"@openbrf/api": patch
"@openbrf/web": patch
"@openbrf/i18n": patch
---

Keep the 72-hour breach clock running until IMY has actually been notified.

A board that decided IMY was to be notified, but had not yet recorded the
notification, saw the breach as "Decided". The reminder stopped and the
overview reported nothing waiting, although art. 33(1) still required the
notification within 72 hours of discovery. Deciding to notify is not the same
as notifying, and the register now keeps the two apart:

- A breach decided with IMY to be notified and no notification recorded is in
  a new `notificationOwed` state, and turns `overdue` 72 hours after discovery,
  in the same way as an undecided breach.
- The board reminder still goes to such a breach, and its text says the
  notification is owed rather than that nothing has been decided.
- The overview counts these breaches (`notificationOwed`) and includes them in
  `overdue`. `nearestDeadline` is replaced by `nearestDecisionDeadline` and
  `nearestNotificationDeadline`, one for each count, and the overview strip
  names both counts with their own hours when both are waiting.
- The register screen has a "Record the notification" action on these rows. It
  records when IMY was notified, IMY's reference if there is one, and the
  reasons for the delay when the notification was late. The action uses the
  existing `PUT /api/data-protection/breaches/:breachId`. The form opens on the
  reference already recorded, so saving only the date does not clear it.
- A notified-at before the discovery or in the future is refused, on both the
  decision and the `PUT` (`notified-out-of-range`, 400), because a notified-at
  still to come would stop the clock with IMY told nothing. The date field
  offers only the moments in between.
- A breach cannot be closed while the notification is owed
  (`imy-notification-owed`, 409), because closing would stop the clock in the
  same way.

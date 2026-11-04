---
"@openbrf/api": minor
"@openbrf/web": minor
"@openbrf/i18n": minor
"@openbrf/shared": minor
---

A handler can mark an issue as a damage case, and the board can ring-fence an
issue type so that nobody but the board reads its issues and nothing about them
leaves it.

- **Damage case.** Any handler the issue lets in marks it as an insurance
  damage, with the insurer, the claim number, the day of the damage and its
  cause, on an open issue or a closed one. The first mark places a legal hold on
  the issue, so its text and photographs are not purged while the claim is
  handled; taking the mark off leaves the hold, which a handler releases on its
  own. The insurer and the claim number are refused while they hold a personal
  identity number, and the audit log and the timeline record the cause and the
  day, never the insurer or the number. A change made from a mark that another
  handler has changed or taken off in the meantime is refused, and the screen
  keeps the draft and offers the current mark, so one handler's claim number is
  not written over by another's unseen.
- **Ring-fenced issue types.** The board ring-fences a type in the settings,
  and the set a new instance starts with has a type for disturbances between
  neighbours ring-fenced, offered to residents. A ring-fenced type is handled
  by the board only, so the property manager never reads, counts or is given
  one of its issues and is unassigned when a type is ring-fenced. No work order
  is written on one, and nothing about one is mailed, to a handler or to the
  person who reported it; a mail that is being handed to the mail server when
  the board ring-fences the type is decided first, and the change waits for it.
  A connected app and the AI package are offered
  neither its issues nor the type. No report under it is made from a post, and
  the website's form offers none: a type on the form is taken off it before it
  can be ring-fenced. The report form and the board's screen each say who reads
  such an issue and what not to write, and that formal steps under the
  Tenant-Ownership Act are taken outside Open BRF.
- **Its own clock.** The free text of a ring-fenced issue is purged one year
  after the issue closes, whatever the board set for other issues, unless a
  legal hold stands on it, a damage case included. The board does not set the
  year; it stays at one year until the legal review of the module says
  otherwise.
- **Lifted only from an unused type.** The ring-fence cannot be lifted once
  anything has been reported under the type, so the earlier reports never reach
  the property manager or the AI package, and never return to the board's
  longer clock. A type ring-fenced by mistake is switched off and replaced. The
  ring-fence holds for what is reported after it is set; a post an earlier issue
  was filed from keeps its link.
- **Record of processing activities.** The issues row says that a ring-fenced
  issue is never mailed about and has its own clock, and that a damage case
  places a legal hold. A row the board has edited keeps its own text and is not
  refreshed.

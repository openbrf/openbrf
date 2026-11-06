---
"@openbrf/api": minor
"@openbrf/web": minor
"@openbrf/i18n": minor
"@openbrf/shared": minor
---

An issue can now carry the resident's entry permission for their apartment,
the common area it is about, and the mark of an inspection finding.

- **Entry permission.** On an issue about an apartment, the resident who
  reported it answers whether the association or a contractor may enter: yes or
  no, and for a yes whether there are pets, whether the master key may be used,
  a short note on how to get in and the last day the permission stands. A
  yes is accepted only from a reporter who still lives in the apartment; a no,
  and withdrawing an answer, are not held to that. A move-out recorded as the
  yes arrives either comes first and refuses it, or waits for it; a yes already
  stored stays until its last day or until the issue closes. A
  handler can record the same answer from what the resident said on the
  telephone. The handler sees and records it also on an issue whose reporter
  has protected personal data, where the queue withholds the apartment: each
  issue in the queue says whether it is about an apartment without naming one.
  The answer is cleared when the issue is closed, in the same step
  that closes it, and the database refuses a closed issue that holds one. A
  note that reads like a door code is refused, with a sentence saying why, and
  is never stored. A time such as 08.00-12.00, a date written 2026-05-12 or a
  year after a month's name such as 12 May 2026 is not taken for a door code;
  a date written 12.05.2026 or 20260512 still is. A note a handler writes is
  also refused while it carries a personal identity number. The answer is on
  the resident's data subject access report while the issue is open. The purge
  of a person clears it from an issue whose text is already gone, when it
  detaches them from that issue, and
  removing the apartment from the register clears it from the issues about that
  apartment, recorded as withdrawn by whoever removed it; an answer saved while
  the apartment is being removed is cleared with them or refused. Nothing of it is offered to a connected app or the AI package.
- **Common areas.** The board keeps a short list of common areas, such as the
  laundry room, the lift and the yard, under Settings, and a report can name one
  beside its free-text location. The list never holds an apartment, and an
  issue about an apartment names no area: the server refuses the pair. A new
  instance starts with nine, and an instance already set up gets the same nine
  when it upgrades, in its own language. A handler can set or change the area on
  an issue, and the queue shows how many issues each area has, closed ones
  included, so a fault that keeps coming back in the same place is seen as one.
  The count is of the issues the reader may open. Choosing an area narrows
  every view of the queue to it, together with the filter, and the queue's
  search finds an issue by the name of its area. An area an issue names is
  switched off and not removed. The area an issue names is on its reporter's
  data subject access report.
- **Inspection findings.** A handler can mark an issue as a finding of an OVK,
  lift or fire inspection, with the day of the inspection, the protocol (one of
  the issue's files for handlers, which residents cannot open) and a target
  date. The target date is the issue's own, so the Overdue view reads it as it
  reads any other and its assignee is reminded once it has passed, and a
  finding cannot be left without one. A lift's must fall
  no later than a month after the inspection (BFS 2025:11, 1 kap. 17 §); the
  other kinds have the date the handler sets. The first mark places a legal
  hold on the issue, so the protocol and the issue's text are kept until a
  handler releases the hold, which the form says; taking the mark off leaves the
  hold standing, and a mark put on again places it again. When
  the protocol is removed from the issue after that, the mark stays.

The audit log records each of these acts with who acted and the facts, never the
note or a file's name; of an entry permission only that an answer was given, which answer, and whether
the reporter gave it, since the rest is about somebody's home and the log
outlives the issue's closing.

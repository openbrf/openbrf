---
"@openbrf/api": minor
"@openbrf/web": minor
"@openbrf/i18n": minor
"@openbrf/shared": minor
---

The data subject access report now gives the text of each work order, as the
board weighs it under GDPR art. 15(4). Before, it gave only whom the work
order went to and when.

- **What the report gives.** On each issue the person reported, and on each
  issue that concerns them, every work order still shows whom it went to, when,
  whether the mail went out and whether a link was given. It now also gives
  what the handler wrote to the contractor, while that text stands. The text is
  given whole, given in part with words left out, or left out because it is
  about somebody else. On an issue the person did not report, it can also be
  left out because it would tell who reported the issue. The report never gives
  the contractor's address or who sent the work order.
- **Weighed like an internal note.** The board weighs each work order from the
  report's screen, beside the issue's other texts. The screen names each work
  order by its recipient. A work order nobody has weighed is listed as not
  given, and the report is not printed until it is weighed.
- **Removed and erased texts.** A text a handler removed says so, with the
  date. A text erased when its retention period ran out says that.
- **Kept and purged with the text.** A work order's text has a clock of its
  own, ten years after its issue closes, and can outlast the rest of the
  issue's free text. Its weighing stays with it when the rest of the free text
  goes. It goes when the text does: when the ten years run out, when a handler
  removes the text, or with the work order. The audit log counts a work
  order's text with the other texts of the weighing.
- **Wording.** The handlers' preview of a work order says that the access
  report can give its text once the board has weighed it. The record of
  processing activities' issues row says that the weighing goes with the
  work order's text. Both are in Swedish and English.

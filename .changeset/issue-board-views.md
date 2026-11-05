---
"@openbrf/api": minor
"@openbrf/web": minor
"@openbrf/i18n": minor
"@openbrf/shared": minor
---

The issue queue has views, a filter and a search, and the board's front page
counts open, overdue and unassigned issues (ADR 0054).

- **Four views.** Mine lists the issues assigned to you. Unassigned lists the
  issues with no assignee. Overdue lists the open issues whose target date has
  passed. All lists every issue you handle. Each view shows how many issues it
  holds. The queue opens on Mine, and the address names the view, so a link or
  a bookmark can open a view directly.
- **Filter and search.** A status filter narrows every view to the open issues
  (the default), one status meaning, or closed issues as well. A type filter and
  a priority filter narrow every view too. The search matches each of its first
  six different words somewhere in an issue's description, location, place,
  type, apartment, reporter's name, conversation with the reporter or
  internal notes, and ignores any words after those. Case does
  not matter, and an accented letter matches whether it was written as one
  character or as a letter with a combining mark (a word that mixes both
  within itself is not found). A percent sign, an underscore or a backslash in a
  word matches itself and nothing else. It never
  matches a reporter with protected personal data by name or apartment, and it
  never finds an issue the reader does not handle. The counts
  follow the same filter and search, and the queue reads a view's list and the
  counts at the same moment, so each count matches its list.
- **Overdue issues stand out.** An overdue issue's row has a heavy edge in the
  danger colour beside its date and the word overdue, and the Overdue count is
  shown in the danger colour while it is above zero.
- **The board's front page.** The issues row shows how many issues are open, how
  many are overdue and how many have no assignee, and each number opens its
  view. The overview's line counts the unassigned open issues for the queue,
  where it counted the new ones before.
- **API.** `GET /api/issue-queue` takes `view` (`MINE`, `UNASSIGNED`, `OVERDUE`,
  `ALL`), `meaning` (a status meaning or `OPEN`), `typeId`, `priority` and `q`,
  and refuses a parameter it does not read. Without any of them it still lists
  every issue the reader handles. `GET /api/issue-queue/counts` takes the same
  filter without `view` and answers how many issues each view holds.
  `GET /api/issue-queue/snapshot` takes the parameters of `GET /api/issue-queue`
  and answers `{ issues, counts }`: the view's list and every view's count, read
  in one transaction. None of them is an action, so nothing changes on `mcp` or
  `ai`.

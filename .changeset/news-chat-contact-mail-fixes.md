---
"@openbrf/api": patch
"@openbrf/web": patch
"@openbrf/i18n": patch
---

Fix a set of defects in news, chat, the contact form and mail delivery.

- A news item taken down before its mailing went out, and then put back up,
  now sends the mailing. Before, the members were never mailed and the board's
  screen showed the mailing as pending for good.
- Saving and publishing a news item check for a personal identity number, and
  refuse to rename a mailed item, on the item as it stands at that moment, so
  a publish or a draft save landing in between cannot slip past either check.
  Two items given the same address at once answer "address taken" rather than
  a server error.
- `news_list` keeps paging past an item removed since the last call. Its
  cursor has a new form: a cursor issued before this release answers
  `not-found`, so start the list again without a cursor.
- The board's news list counts each mailing in the database instead of
  reading every delivery row.
- The board is told about contact form messages through jobs that retry over
  about half an hour and are logged when they give up. Across the instance, the
  board is mailed about at most ten contact messages an hour; messages past
  that are stored and shown in the inbox as always.
- The contact inbox is read a page at a time and says how many messages are
  waiting, so a burst of messages no longer hides the ones after it. Several
  messages can be selected and deleted together. Handling or deleting a
  message another board member just deleted says so rather than failing.
- Chat write limits (messages, groups) and the news comment limit hold under
  many requests sent at once. A report sent while the board strikes the
  message through is refused. A chat message written in the same millisecond
  as another is no longer missed by an open chat screen. A group's name may
  not carry a personal identity number, and a group's member list no longer
  shows people who have moved out.
- With no mail configured, an instance outside production no longer prints
  messages, sign-in links included, to its log. A developer who wants that
  sets `OPENBRF_MAIL_LOG_BODY=true`. Dates such as a move-in day are written
  in mail as the day they are, and the stored SMTP password is decrypted once
  rather than for every message.

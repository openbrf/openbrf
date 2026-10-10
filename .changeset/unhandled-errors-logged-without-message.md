---
"@openbrf/api": patch
---

Log an unexpected request failure by its class and call frames, never its
message.

A failure no rule anticipated reached Nest's own last resort, which wrote the
error's message and stack to the log. Those messages are composed where the
error is thrown, from whatever was being handled: a mail server's rejection
quotes the recipient's address, and a database error can quote the value that
broke a constraint. Such failures are now answered with the same generic 500 and
logged as the failure's class, its code where it has one, and its call frames,
which is what ADR 0007 asks of every other log line. Server-side refusals and a
website not-found page that cannot be rendered are logged the same way.

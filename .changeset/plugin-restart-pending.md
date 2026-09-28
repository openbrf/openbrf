---
"@openbrf/api": patch
"@openbrf/web": patch
---

Keep the restart notice on the plugins screen until the new process serves the
plugin.

An install or a removal is answered as soon as its reconcile is queued, and the
job then runs the whole reconcile, npm included, before it hands over to the
restart. Through that window the plugin overview reported no restart pending, so
the screen's first check after two seconds could take the outgoing process's
answer for the replacement's: it stopped waiting and stayed on "Installerat,
väntar på omstart" while the new process was already running the plugin.

The overview now reports a restart pending from the moment an operation that ends
in one is accepted, and from the moment the worker picks up a reconcile the
command-line tool queued, until the process is replaced. It also names the
process that answered, and the screen leaves the restart notice only once a
different process answers with nothing pending.

A removal while plugins are switched off no longer answers that the application
is restarting: nothing runs the reconcile then, and nothing is replaced.

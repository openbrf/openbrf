---
"@openbrf/api": patch
---

Test every job that carries out a granted erasure against everything that
refuses one. Only the booking purge had been tested for this, and only with a
board seat. A new integration spec runs the eight domain jobs and the
service-data purge against seven cases: a legal hold, a restriction of
processing, a residency or a board seat with no end, one ending tomorrow, and a
system role. Each also gets a control run with no refusal. A domain added to the
erasure registry later fails the spec until it has a fixture of its own. No
behaviour changes.

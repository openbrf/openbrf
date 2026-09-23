---
"@openbrf/api": patch
---

Erase a person's chat messages on the night their erasure is carried out, not a
year later.

A granted erasure request brings every purge that reads it forward for one
person, and the service-data purge is the job that marks the request executed
and closes it. The chat purge was scheduled after that job, so by the time it
ran the request was closed and it no longer selected the person: their messages
stayed until each one's own year ran out, while the request recorded the erasure
as carried out. The chat purge now runs before the service-data purge, like
every other purge that reads the request, and the order is enforced for any
purge added later.

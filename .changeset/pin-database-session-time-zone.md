---
"@openbrf/api": patch
---

The connection the application reads and writes its data through now asks the
database for the UTC time zone. A time that raw SQL wrote with
`clock_timestamp()` or `now()` into a column without a time zone used the
server's own zone, so on a database not set to UTC it read hours off from what
the application compared it with. The PostgreSQL image Open BRF ships was
already UTC, so a standard installation is unchanged; a database of your own
that is not UTC no longer shifts these times. The migrations and the job queue
still use the server's setting; see "The database's time zone" in the
deployment guide.

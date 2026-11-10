---
"@openbrf/api": patch
"@openbrf/i18n": patch
---

The reporter's private link page no longer labels two different things with
the same English word. The status of a new issue still reads "Received", and
the date it came in is now labelled "Filed" instead of "Received". The Swedish
page is unchanged. The comment in `docker-compose.prod.yml` above
`OPENBRF_CONTRACTOR_LINKS_ENABLED` now says what `docs/deployment.md` says: the
contractor's link stays off until counsel answers whether it makes the
contractor a processor.

---
"@openbrf/api": minor
---

The issue queue's search reads the messages and internal notes on issues
through trigram indexes, so a search no longer reads every message and note in
the database for each of its words. What a search finds is unchanged. The
database server has to offer PostgreSQL's `pg_trgm` extension, which the
bundled database includes and which the migrations create without a superuser
(docs/deployment.md, "The search's extension"). Where the server holds it in
another schema already, the schema owner needs `USAGE` on that schema.

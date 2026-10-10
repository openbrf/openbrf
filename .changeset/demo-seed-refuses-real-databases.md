---
"@openbrf/api": patch
---

Seed the demo association only when asked for, and never over a real one.

`db:seed` was held back by `NODE_ENV` alone, which defaults to development, so
run from a checkout whose `DATABASE_URL` pointed at a real instance it renamed
the association, added a hundred people and wrote member register entries that
can never be deleted. It now needs `--demo-data` on the command line
(`pnpm --filter @openbrf/api db:seed --demo-data`), and refuses a database that
holds an association under another name, or any person or member register
entry it did not write itself.

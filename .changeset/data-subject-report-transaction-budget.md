---
"@openbrf/api": patch
---

Give the data subject access report, and the art. 20 portability export built
from it, thirty seconds to assemble rather than five.

The report is gathered in one transaction, so that it and the audit entry
recording it commit together, and that transaction ran under the database
client's default limit of five seconds. The report is some forty queries in a
row and grows with the person's history - every audit entry naming them, every
letter to the board mailbox in full - so on a slow database a person who has
lived in the association a long time could pass the limit, and the report then
failed with a server error every time it was asked for. That is an access
request the board cannot answer within the month the law gives it.

The transaction only reads until the audit entry at its end, so the longer limit
holds no locks on anybody else's work.

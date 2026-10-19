---
"@openbrf/api": minor
"@openbrf/web": minor
"@openbrf/i18n": minor
---

The apartment register now records what bostadsrättslagen 9 kap. 10 § lists
for each apartment and it lacked: the number of rooms, the other spaces the
tenant-ownership covers, and the day Bolagsverket registered the economic plan
the apartment was granted under. The living area is recorded beside them, for
the broker's description of the apartment. The board records all four for
every apartment in one form on the apartment register, and each change is
written to the audit log, which names the fields and not their values.

The register and every extract show them, the tenant-owner's own extract
included, since 9 kap. 11 § makes that extract cover every field 10 § lists. The
initial supply file gains a column, `apartmentOtherSpaces`, which answers
whether land and other spaces are included in the grant (Förordning (2026:898)
2 kap. 3 § första stycket 6) with the register's description of them.

Existing apartments show the new fields as not recorded until the board fills
them in. The migration adds nullable columns and needs no manual step.

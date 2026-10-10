---
"@openbrf/api": patch
---

Read which rows of the record of processing activities name the mail server
from the mail templates themselves. Each template now declares the processing it
is sent under, and the seed collects those rows instead of keeping its own list.
The breach reminder and the reporting obligation notice had been missing from
that list. A unit spec walks the source for every mail template and fails for
one the seed does not reach, or one that declares no processing without being
named as sent on none. The plugin message is the only one so named. The record
itself says the same as before.

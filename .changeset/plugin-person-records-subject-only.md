---
"@openbrf/plugin-sdk": minor
"@openbrf/api": minor
---

A record a plugin keeps about a person names nobody but that person. A put
whose key, a string in its value or a property name is the id of another
person is refused with `PluginRecordOtherPersonError`, so the data subject
access report never prints one person's record on another's report. Catalog
review accepts a plugin only if its values name no one but the subject.

Of a record rewritten many times while a legal hold or a restriction stands,
the host keeps the first version set aside and the last one of each day, so
the versions kept do not grow with every write. Removing a plugin keeps the
same versions of each record. The plugin cannot tell from this that a hold
stands.

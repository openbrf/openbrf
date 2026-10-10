---
"@openbrf/api": patch
---

Hold an apartment binder to its size bound when two files arrive together. The
room left was counted before the upload and never again, so two filings that
each fitted could both be written. The count is now repeated under an advisory
lock on the apartment when the entry is written, and a filing that no longer
fits is refused and its file removed.

---
"@openbrf/api": patch
"@openbrf/web": patch
"@openbrf/i18n": patch
"@openbrf/shared": patch
---

Say why a plugin install failed in the reader's language.

The plugins screen showed the installer's own English for every failed install,
whatever language the interface was set to. An install failure is now recorded
as a reason and the values its sentence needs - the download budget, a
deadline, a size cap, a status code, a package name - and the screen and
`openbrf plugin list` say it from the application's translations. Every way the
install can fail has a reason of its own: a download that ran out of time or of
the run's budget, a source the instance does not read or cannot reach, an
archive that is too large or does not match its checksum, an archive that
holds another package, and a failed or unexpected npm install.

What the installer threw is still kept beside the reason, and `openbrf plugin
list` prints it under the sentence. A plugin that failed before this version
has no reason recorded and keeps showing the text it had. The migration adds
two columns and changes nothing already stored.

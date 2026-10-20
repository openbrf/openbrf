---
"@openbrf/plugin-sdk": minor
"@openbrf/api": minor
"@openbrf/web": minor
"@openbrf/i18n": minor
"@openbrf/shared": minor
---

Let a plugin offer extension points and another plugin extend them (ADR 0030).

A host plugin declares `extensionPoints` in its manifest, defines each point's
input and output schemas with `host.extensions.define`, and calls the addons
serving there with `host.extensions.list` and `host.extensions.invoke`. An addon
declares `extends` and registers its handler with `host.extensions.contribute`.
The host validates both directions against the host plugin's strict schemas and
copies the values as JSON, and answers for what an addon does - not serving,
timed out, failed, output invalid - in the result rather than by throwing. An
answer longer than `EXTENSION_MAX_OUTPUT_LENGTH` as JSON is refused unparsed.
A plugin that reads the address book and one that asks for `site:blocks` do not
extend each other, in either direction, and a website addon extends only a
plugin that handles no personal data. Nor are the two joined through other
plugins: where the plugins joined by extensions would hold both, the loader
refuses the website addon (or, failing that, the addon that joins them) before
its code runs, whatever order it finds the packages in, and the catalog refuses
the index.

Each addon is installed, consented to and switched on by itself, and never
receives the host plugin's permissions. Its consent screen says what it extends
and which personal data it hands over; the host plugin's says what its points
accept. An addon whose host plugin is missing, switched off or removed does not
serve, and the admin screen gives one of nine new findings
(`extension-host-missing`, `extension-point-unknown`,
`extension-version-unsupported`, `extension-personal-data-refused`,
`extension-permission-refused`, `extension-host-personal-data-refused`,
`extension-group-refused`, `extensions-widened`, `extension-refused`). The catalog index gains version 2,
which carries both declarations; version 1 is still read.

`PluginBlockAbortSignal` is now an alias of the new `PluginAbortSignal`.

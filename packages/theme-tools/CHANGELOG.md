# @openbrf/theme-tools

## 1.0.0

### Major Changes

- 24ed1a8: Publish the plugin SDK, the theme tools and the design tokens publicly on
  npmjs.com, with a provenance attestation. A plugin or theme author outside the
  organization can now install the contract they write against, and run in their
  own CI the same package checks the core runs at install time. Each package
  carries the AGPL and the Open BRF Module Exception, which is what lets a module
  be licensed on its author's own terms.

  The first release is 1.0.0 for all three. The plugin SDK's major version is the
  plugin API version, and the theme tools' and the tokens' major version is the
  token contract's, so a major tells an author which hosts a package works with.

### Minor Changes

- e7776cb: Read themes from the same catalog index plugins are read from.

  One index lists plugins and themes alike, in the format the plugin contract
  documents. The theme screen reads it through the same client as the plugin
  screen: the curated catalog when none is configured, the refusal of any other
  index unless the instance has opted out of curation, https only for a curated
  instance, and the digest checked before a package is unpacked. A theme's name
  and description in the catalog are shown in the viewer's language.

  An index in the earlier theme-only shape is no longer read. An index that lists
  the same id twice is refused as a whole.

  `@openbrf/plugin-sdk` exports the index's schema, `parseCatalogIndex`, and
  `pluginPackageProblems`, the check a plugin's own CI runs on its packed tarball.
  `@openbrf/theme-tools` exports `lintThemePackage`, the same check for a theme.
  The catalog token is sent to the index, and to an artifact only on the index's
  own origin.

- ee46048: Install themes as data-only plugins, with inheritance.

  A theme is a manifest, token values for both modes, bundled font files with
  their licences, an optional logo and a choice among the core's own view
  variants. It carries no code, so installing or switching one writes files and a
  row and needs no restart.

  The install path reads a catalog entry, verifies the package against the sha512
  the catalog states, reads the archive and runs the theme lint before anything is
  written. The lint is a gate: it refuses a theme that renders the statutory
  register below WCAG AA in either mode, one carrying anything executable, and one
  whose fonts are not bundled and licensed. A theme declares `extends` and states
  only what it changes; the default theme is built in, always inheritable and
  cannot be removed. An administrator previews an installed theme in their own
  browser session before activating it.

  `@openbrf/theme-tools` holds the manifest schema, the lint, `extends`
  resolution, the view-variant registry and the archive reader, so a theme
  repository's CI can run the same check the core runs at install time.

### Patch Changes

- 425f11e: Count every file record in a theme archive toward the 200-file limit, not only
  distinct paths. An archive that repeated one path more than 200 times used to
  pass the limit; it is now refused with the same message.
- bb36c9b: Refuse theme archives that `tar` and Python's tarfile would list differently
  from the installer: a header after a lone zero block, a directory entry that
  states a size, and a path prefix in a header without the ustar magic. Archives
  written by `writeThemeArchive`, `npm pack`, GNU tar and bsdtar read as before.
- 1abe5bf: Refuse theme archives whose tar headers other tools read differently.

  A name or prefix with a leading byte order mark is no longer stripped to
  look like the plain name, and a field that is not UTF-8 is refused. A name or
  prefix with anything but NULs after its first NUL is refused too.

  Size, checksum, mode, uid, gid, mtime, devmajor and devminor must be leading
  spaces, octal digits, then only spaces and NULs. A NUL before the digits is
  refused, and so is anything else (a tab, a non-breaking space), which makes
  size and the checksum stricter than before. GNU tar and bsdtar write a uid, gid
  or mtime that does not fit octal (a uid above 2^21, a negative mtime) in
  base-256: those fields (not used) are accepted when they start with 0x80 or
  0xff, while a base-256 size or checksum is refused.

  A `.` path segment left after the common root is stripped is refused, so
  `theme.json` and `./theme.json` cannot be two entries for one file. Archives
  made with `tar -czf x.tgz -C dir .` still read.

  A base-256 uid, gid, mtime, mode or device number is accepted only when its
  value is a safe integer, as node-tar reads it. The checksum must end in a space
  or NUL, a regular-file or directory header with a link name is refused, and the
  writer refuses `.` segments too.

- f148a18: Stop `readThemeArchive` from unzipping a theme package that inflates far past
  the archive limits. The decompressor now stops at the most a package within
  those limits can occupy and the reader refuses it with a `ThemeArchiveError`,
  instead of holding a gzip bomb in memory until the size check runs.

  To give that ceiling a bound, directory records now have a limit of their own:
  an archive may hold at most 200 (`MAX_DIRECTORY_RECORDS`), alongside its 200
  files, and one with more is refused. They used to be skipped without limit.
  Directory records still do not count toward the file limit. Other packages
  within the limits and packed the usual way (by `writeThemeArchive` or a
  standard `tar`) read exactly as before.

- f25d264: A theme archive whose header checksum matches only the signed byte sum is now
  refused.

  node-tar computes only the unsigned sum, so with a byte of 0x80 or more in a
  header it skipped that header and read its data as headers, listing different
  files than the theme tools did. Archives from the theme tools, `npm pack`, GNU
  tar and bsdtar carry the unsigned sum and still read.

- 9f7cb16: Give the package a browser entry. A bundler that resolves the `browser` export
  condition, as Vite does for the browser, now loads everything except the
  archive reader and writer and the package lint built on them
  (`readThemeArchive`, `writeThemeArchive`, `ThemeArchiveError`, the archive
  limits, `readThemePackage`, `lintThemePackage` and `lintThemeAgainst`). Those
  unpack with `node:zlib`, and importing them in a browser broke the module
  graph: under the Vite development server the page stayed blank. Node, and
  anything else that does not resolve the `browser` condition, gets the full
  package as before.
- c71c849: Check theme input more strictly.

  - `parseColor` returns null for an `rgb()` channel outside 0-255 or not a
    number, and `checkContrast` fails a ratio that is not a number.
  - `tokensToCssDeclarations` writes only the contract's token names.
  - A manifest's font family may not hold a control character, and
    `buildFontFaceStylesheet` leaves out a face it cannot write instead of
    throwing.
  - `readThemeArchive` refuses a path `isPackagePath` refuses.

- Updated dependencies [24ed1a8]
- Updated dependencies [c71c849]
  - @openbrf/tokens@1.0.0

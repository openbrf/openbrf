---
"@openbrf/plugin-sdk": minor
"@openbrf/api": patch
---

Install plugins from their verified archives alone, and load only the package
the board consented to.

The plugin installer runs npm offline, with a cache of its own that starts
empty, no npm configuration from the host, and a minimal environment built from
an allowlist. npm has nothing to install but the archives whose digests the
catalog stated.

`pluginPackageSchema` in `@openbrf/plugin-sdk` refuses a package whose
`dependencies`, `optionalDependencies`, `bundleDependencies` or
`bundledDependencies` is anything but absent, an empty map or an empty list, as
the plugin contract requires. The loader
reads the same schema, so such a package is reported as `manifest-invalid` and
not loaded.

A plugin must match the package name and version the board consented to. The
installer reads each archive's own `package.json` before npm runs and refuses a
package that does not match or declares a dependency, so npm never resolves a
`file:` dependency from elsewhere on the volume. After npm, it checks that the
staged tree holds exactly the consented packages before it puts the new
installation in place, and fails the install otherwise. At boot, a plugin
that does not match is refused as `not-consented`, and the volume is reported
as needing a reconcile.

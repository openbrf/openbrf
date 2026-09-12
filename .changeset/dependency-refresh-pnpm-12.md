---
"@openbrf/api": patch
"@openbrf/web": patch
"@openbrf/plugin-sdk": patch
---

Move every package, container image and pinned action to its current release.

Better Auth 1.7.3 restores the 1.6 account schema, in which an account is
identified by its provider and the provider's account id. The required `issuer`
that 1.7.0 through 1.7.2 added is no longer written, so a migration drops the
column: left in place as NOT NULL, it refuses every account the application
creates. Nothing reads it, and every existing row holds the value derived from
the credential provider.

pnpm moves to 12. Installing the reference plugin under `fixtures/` with the
workspace ignored is not enough under 12, which still resolves that install
against the workspace root and links none of the plugin's own dependencies, so
the fixture build names the plugin as its lockfile directory.

Prisma stays on 7.10.0. Its `latest` tag names a release candidate,
8.0.0-rc.13, while the client and the adapter are at 7.10.0 and the three move
as one.

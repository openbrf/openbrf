---
"@openbrf/api": minor
"@openbrf/web": minor
"@openbrf/plugin-sdk": minor
---

Move every dependency, container image and pinned action to its current
release, and clear the deprecations that came with them.

NestJS 12 ships as ES modules, and its package no longer lists its own
manifest in its exports map. The plugin resolution bridge asked for
`@nestjs/common/package.json` to find the directory a shared package resolved
from, so under v12 that question had no answer: the bridge reported the host's
`node_modules` as unlocatable, and the identity check that refuses a plugin
carrying its own copy of NestJS resolved nothing and therefore found nothing to
refuse. Both now resolve the package entry and walk up to the `node_modules`
that encloses it, which is a question every package can answer whatever it
ships and however deep its exports map points. The bridge itself is unchanged -
CommonJS resolution still honours `NODE_PATH`, and a required ES module still
lands in the one module cache, so a plugin still gets the host's NestJS and not
a second one.

`@nestjs/platform-fastify` and the API now agree on one Fastify version, so
only one copy of its type declarations is in the tree and multipart
registration no longer needs to be cast onto a signature it already had. The
plugin contract's peer range moves to NestJS 12, and the reference plugin
fixture with it.

Nodemailer 10 carries its own type declarations, so the separate `@types`
package is gone. `better-sqlite3` - which arrives as an optional peer, is never
loaded, and is never compiled - is pinned to the major that dropped the
unmaintained `prebuild-install`, which was the last deprecation warning on
install. Prisma stays on 7.10.0: its `latest` tag currently points at a release
candidate that `@prisma/client` has no counterpart for.

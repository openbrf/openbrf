# The production image: one container serving the API and the built SPA
# (decision 32). PostgreSQL runs beside it; see docker-compose.prod.yml.
#
# Base image. Debian slim rather than Alpine, for two runtime dependencies that
# ship prebuilt binaries against glibc and would otherwise have to be compiled
# inside the image: sodium-native, reached through ciphersweet-js (ADR 0002),
# and the Prisma schema engine that applies migrations at boot. The image
# therefore needs no build toolchain. It also carries the npm CLI, which the
# plugin install job shells out to (ADR 0003).
#
# The tag is pinned to the exact Node version in .nvmrc, and the digest to the
# image that tag named when it was written. Bump all three together; Dependabot
# proposes the digest (.github/dependabot.yml).
#
# A tag is a name its owner can move, so a build from a tag alone is a build
# nobody can reproduce and nobody can attest to. The digest is what makes two
# builds of one commit the same build. Everything else this repository depends
# on is pinned the same way - actions by commit, the Postgres image and the
# Semgrep image by digest.
ARG NODE_IMAGE=node:26.8.1-bookworm-slim@sha256:367679cf9792759492a486e4aa4b421764d71a9546a6dae8aab81a99eb797b3e
ARG PNPM_VERSION=11.24.0

# --- base -------------------------------------------------------------------
# pnpm is installed with npm, never corepack: Node 26 no longer bundles corepack
# and nothing in this repository may depend on it (CONTRIBUTING.md).
#
# openssl is not linked against, only looked for: the Prisma CLI probes for it
# to choose an engine build and warns on every run when it finds nothing. The
# warning is harmless here - Prisma 7 reaches PostgreSQL through a driver
# adapter - but neither a build log nor a start-up log should open with a
# warning that means nothing.
FROM ${NODE_IMAGE} AS base
ARG PNPM_VERSION
ENV PNPM_HOME=/usr/local/pnpm \
    PATH=/usr/local/pnpm:$PATH
RUN apt-get update \
    && apt-get install --yes --no-install-recommends openssl \
    && rm -rf /var/lib/apt/lists/* \
    && npm install --global pnpm@${PNPM_VERSION}
WORKDIR /app

# --- build ------------------------------------------------------------------
# One install for the whole workspace, then the Prisma client, then turbo
# builds the packages, the API and the web client in dependency order.
FROM base AS build
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @openbrf/api db:generate
RUN pnpm build

# Prune the development dependencies from the tree that ships. The Prisma CLI
# survives because it is a runtime dependency of the API: the entrypoint applies
# migrations with it on every start.
#
# Switching an existing install to --prod makes pnpm rebuild node_modules, and
# it asks before doing that unless it is told there is no one to ask.
RUN pnpm install --frozen-lockfile --prod --config.confirmModulesPurge=false

# --- runtime ----------------------------------------------------------------
FROM base AS runtime

ENV NODE_ENV=production \
    PORT=3000 \
    OPENBRF_DATA_DIR=/data \
    OPENBRF_WEB_ROOT=/app/apps/web/dist

# tini forwards signals and reaps orphans, so a restart during a plugin install
# is a clean shutdown rather than a SIGKILL ten seconds later.
#
# psql applies prisma/sql/harden-runtime-role.sql at boot. That script is
# written in psql's own dialect (\getenv, \gexec) because it must keep the
# runtime password out of the process arguments, so there is no way to run it
# from a driver. The client is older than the server it talks to, which is
# supported for executing SQL; pg_dump is not version tolerant in that
# direction and backups are taken from the database container instead
# (docs/backup-and-restore.md).
RUN apt-get update \
    && apt-get install --yes --no-install-recommends tini postgresql-client \
    && rm -rf /var/lib/apt/lists/*

# The pruned workspace, with node_modules laid out exactly as it was built:
# pnpm's virtual store is a symlink farm, so the tree only resolves at the path
# it was installed at.
COPY --from=build --chown=node:node /app /app

COPY docker/entrypoint.sh /usr/local/bin/openbrf-entrypoint
COPY docker/database-url.mjs /app/docker/database-url.mjs
COPY docker/first-boot.mjs /app/docker/first-boot.mjs
COPY docker/with-owner-url.mjs /app/docker/with-owner-url.mjs
COPY docker/harden-runtime-role.mjs /app/docker/harden-runtime-role.mjs

# The plugin install job runs `npm install <tarball>` into the data volume, so
# the CLI has to exist in the runtime image and not only in the build stage.
RUN chmod 0755 /usr/local/bin/openbrf-entrypoint \
    && install -d -o node -g node -m 0700 /data \
    && npm --version > /dev/null

# Declared so an empty named volume inherits this directory's owner and mode.
# A bind mount does not: the entrypoint checks writability and says so.
VOLUME ["/data"]
EXPOSE 3000

# Never root. The data volume holds the field encryption key, and a container
# escape should not begin at uid 0.
USER node
WORKDIR /app/apps/api

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/openbrf-entrypoint"]
CMD ["node", "dist/main.js"]

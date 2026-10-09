# The production image: one container serving the API and the built SPA
# (decision 32). PostgreSQL runs beside it; see docker-compose.prod.yml.
#
# Base image. Debian slim rather than Alpine, for two runtime dependencies that
# ship prebuilt binaries against glibc and would otherwise have to be compiled
# inside the image: sodium-native, reached through ciphersweet-js (ADR 0002),
# and the Prisma schema engine that applies migrations on every deploy. The image
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
#
# Written into the FROM line rather than held in an ARG, because Dependabot
# reads image references off FROM and does not resolve a variable: an ARG here
# would be a pin with nothing updating it, which is the failure the updater was
# added to prevent.
ARG PNPM_VERSION=12.9.1

# --- base -------------------------------------------------------------------
# pnpm is installed with npm, never corepack: Node 26 no longer bundles corepack
# and nothing in this repository may depend on it (CONTRIBUTING.md).
#
# openssl is not linked against, only looked for: the Prisma CLI probes for it
# to choose an engine build and warns on every run when it finds nothing. The
# warning is harmless here - Prisma 7 reaches PostgreSQL through a driver
# adapter - but neither a build log nor a start-up log should open with a
# warning that means nothing.
#
# ca-certificates gives the build its own public CA bundle. With
# --no-install-recommends the slim image gets an empty /etc/ssl/certs and no
# public CA bundle, and pnpm reads the system store: an install then works only
# where the Docker host happens to put a trusted CA into the build, and fails
# with UnknownIssuer where the host injects only its own root. A build behind a
# TLS-inspecting proxy whose root is not public still fails; that root has to be
# added to the image. The runtime stage inherits the bundle through FROM base but
# does not depend on it: Node uses its bundled roots for the outbound TLS (catalog
# and tarball fetches, mail, SMS, S3, client metadata) unless NODE_USE_SYSTEM_CA
# or --use-system-ca is set, and neither is.
FROM node:26.10.0-trixie-slim@sha256:930557a230abacbc3f4fd9b8648abf8f4bee1e17cb72195dcdfb2f709bc85b33 AS base
ARG PNPM_VERSION
ENV PNPM_HOME=/usr/local/pnpm \
    PATH=/usr/local/pnpm:$PATH
RUN apt-get update \
    && apt-get install --yes --no-install-recommends ca-certificates openssl \
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
# survives because it is a runtime dependency of the API: the migrate service
# applies migrations with it on every deploy.
#
# Switching an existing install to --prod makes pnpm rebuild node_modules, and
# it asks before doing that unless it is told there is no one to ask.
RUN pnpm install --frozen-lockfile --prod --config.confirmModulesPurge=false

# --- runtime ----------------------------------------------------------------
FROM base AS runtime

# The npm cache under /tmp rather than the home directory: the plugin install
# job runs npm, and the compose file mounts the root filesystem read-only with
# a tmpfs at /tmp. CHECKPOINT_DISABLE keeps the Prisma CLI from writing its
# update check to a cache directory for the same reason.
ENV NODE_ENV=production \
    PORT=3000 \
    OPENBRF_DATA_DIR=/data \
    OPENBRF_WEB_ROOT=/app/apps/web/dist \
    npm_config_cache=/tmp/npm-cache \
    CHECKPOINT_DISABLE=1

# tini forwards signals and reaps orphans, so a restart during a plugin install
# is a clean shutdown rather than a SIGKILL ten seconds later.
#
# psql applies prisma/sql/harden-runtime-role.sql in the migrate service. That script is
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
#
# Owned by root and not writable by the user the application runs as. This is
# the code the schema-owner and migrate services run with the superuser's and
# the schema owner's connections - the SQL, the scripts, the Prisma CLI and
# every package under them - and the
# code the application runs on its next start, so none of it may be something
# the running application can change. /data is the only place it writes.
COPY --from=build /app /app

COPY docker/entrypoint.sh /usr/local/bin/openbrf-entrypoint
COPY docker/database-url.mjs /app/docker/database-url.mjs
COPY docker/psql.mjs /app/docker/psql.mjs
COPY docker/check-schema-owner.mjs /app/docker/check-schema-owner.mjs
COPY docker/first-boot.mjs /app/docker/first-boot.mjs
COPY docker/with-owner-url.mjs /app/docker/with-owner-url.mjs
COPY docker/harden-runtime-role.mjs /app/docker/harden-runtime-role.mjs
COPY docker/schema-owner.mjs /app/docker/schema-owner.mjs
COPY docker/schema-owner.sql /app/docker/schema-owner.sql

# The plugin install job runs `npm install <tarball>` into the data volume, so
# the CLI has to exist in the runtime image and not only in the build stage.
RUN chmod 0755 /usr/local/bin/openbrf-entrypoint \
    && install -d -o node -g node -m 0700 /data \
    && npm --version > /dev/null

# The installer reads each archive's package.json by unpacking it with the API's
# own node-tar, the way npm unpacks it (apps/api/src/packaging/
# archive-package-json.ts). That reads the file npm reads only while both are
# the same node-tar. The API pins `tar` to the exact version npm bundles, and
# the base image and that pin are bumped separately, so the build stops here
# when the two differ: bump the pin to npm's version.
RUN app_tar="$(node -p 'require("/app/apps/api/node_modules/tar/package.json").version')" \
    && npm_tar="$(node -p 'require(process.argv[1]).version' "$(npm root --global)/npm/node_modules/tar/package.json")" \
    && if [ "$app_tar" != "$npm_tar" ]; then \
         echo "apps/api pins tar $app_tar, but the npm in the image bundles tar $npm_tar." >&2; \
         exit 1; \
       fi

# Declared so an empty named volume inherits this directory's owner and mode.
# A bind mount does not: the entrypoint checks writability and says so.
VOLUME ["/data"]
EXPOSE 3000

# Never root. The data volume holds the field encryption key, and a container
# escape should not begin at uid 0.
USER node
WORKDIR /app/apps/api

# What the image says about itself. Declared after everything above, so a new
# version or revision changes these last layers and reuses every build layer.
#
# The revision can only arrive as an argument: .dockerignore keeps .git out of
# the build context. The workflow that publishes the image
# (.github/workflows/image.yml) passes both; a local build that passes neither
# gets empty labels and an instance that names no revision on start.
ARG OPENBRF_VERSION=""
ARG OPENBRF_REVISION=""
ENV OPENBRF_REVISION=${OPENBRF_REVISION}
LABEL org.opencontainers.image.title="Open BRF" \
      org.opencontainers.image.source="https://github.com/openbrf/openbrf" \
      org.opencontainers.image.licenses="AGPL-3.0-only" \
      org.opencontainers.image.version="${OPENBRF_VERSION}" \
      org.opencontainers.image.revision="${OPENBRF_REVISION}"

# The same check docker-compose.prod.yml runs, here as well because an
# orchestrator that starts the image rather than that file reads the image's.
# No curl in the image, so the check runs in the runtime already there.
#
# The start period is long on purpose. The application encrypts any file
# stored before encryption existed (ADR 0015) before the server listens; a
# check failing meanwhile is not an unhealthy instance.
HEALTHCHECK --interval=10s --timeout=5s --start-period=90s --retries=6 \
    CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

# The application by default. docker-compose.prod.yml runs the same image
# twice more first: with `schema-owner`, which creates the schema owner as the
# superuser, and with `migrate`, the deploy steps as that owner. Each does its
# one job and exits (docker/entrypoint.sh).
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/openbrf-entrypoint"]
CMD ["node", "dist/main.js"]

#!/usr/bin/env bash
#
# Dev Container first-run setup: everything between an empty container and a
# checkout a contributor can actually run `pnpm verify` and the API against.
#
# The core repo's container is deliberately standalone - someone touching only
# core must never need sibling clones, which is what openbrf/dev-workspace is
# for - so this script has to bring up its own database rather than assume a
# parent workspace did it.
#
# Runs once, on create. Bringing the database back up after a plain container
# restart is postStartCommand's job; see devcontainer.json.
set -euo pipefail

cd "$(dirname "$0")/.."

# --- Node and dependencies ------------------------------------------------
# .nvmrc pins an exact version and is the single source of truth (CONTRIBUTING).
# shellcheck disable=SC1091
source "${NVM_DIR}/nvm.sh"
nvm install
nvm use

pnpm install

# --- Instance configuration -----------------------------------------------
# .env is gitignored, so a fresh clone has none, and Prisma 7 does not load one
# on its own (apps/api/prisma.config.ts reads the repo-root file explicitly).
# The committed example already points at the compose database and carries
# dev-only secrets. An existing .env is never touched.
if [ -e .env ]; then
  echo "==> .env already exists, leaving it untouched"
else
  cp .env.example .env
  echo "==> wrote .env from .env.example"
fi

# --- Prisma client --------------------------------------------------------
# apps/api/src/generated/ is gitignored, and lint, typecheck and test all
# depend on it, so `pnpm verify` cannot pass on a fresh clone until this has
# run. Code generation reads the schema alone and needs no database.
pnpm --filter @openbrf/api db:generate

# --- Database -------------------------------------------------------------
# Everything past this point needs PostgreSQL. Docker-in-docker is not always
# ready the moment postCreateCommand fires, and a failure here should not leave
# the contributor staring at a red container with no idea what to do: the
# editor, lint, typecheck and unit tests are all fully usable without a
# database, so report the one command that finishes the job and exit clean.
#
# `--wait` blocks on the healthcheck in docker-compose.yml, so the migrations
# below are not racing the server's startup.
# Each stage is checked on its own so the message names what actually failed.
# Collapsing them into one condition made every failure read as "the database
# did not come up", which is false and actively unhelpful when the server is up
# and it was a migration that broke.
if ! docker compose up -d --wait db; then
  echo "!!! the database did not come up, so migrations were skipped."
  echo "!!! once Docker is running, finish the setup with:"
  echo "!!!   bash .devcontainer/post-create.sh"
elif ! pnpm --filter @openbrf/api db:deploy; then
  echo "!!! the database is up, but applying migrations failed."
  echo "!!! the error above is the real one; this is not a Docker problem."
  echo "!!! retry with:"
  echo "!!!   pnpm --filter @openbrf/api db:deploy"
elif ! pnpm --filter @openbrf/api db:jobs; then
  echo "!!! migrations applied, but installing the pg-boss job schema failed."
  echo "!!! retry with:"
  echo "!!!   pnpm --filter @openbrf/api db:jobs"
else
  echo "==> database ready: migrations applied, pg-boss job schema installed"
fi

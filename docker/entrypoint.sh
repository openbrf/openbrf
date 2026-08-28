#!/bin/sh
# Container entrypoint. Everything a deploy needs, in the one order that is
# safe, before the application takes over as pid 1's child.
#
#   1. the data volume exists and is writable
#   2. a field encryption key exists (ADR 0004)
#   3. the schema is migrated, as the owner
#   4. the job queue schema is installed, as the owner
#   5. the runtime role is created and constrained, as the owner
#   6. the application starts, connecting as the runtime role
#
# Steps 3 to 5 are idempotent and run on every start, so an upgrade is
# `docker compose pull && docker compose up -d` and nothing else.

set -eu

DATA_DIR="${OPENBRF_DATA_DIR:-/data}"
KEY_DIR="${DATA_DIR}/keys"
PRISMA="./node_modules/.bin/prisma"

log() {
  echo "openbrf: $*"
}

fail() {
  echo "openbrf: $*" >&2
  exit 1
}

if [ -z "${DATABASE_URL:-}" ]; then
  fail "DATABASE_URL is not set. It must point at the schema owner, which is the role that runs migrations."
fi

# --- 1. the data volume -----------------------------------------------------
# uploads, plugins and themes are created ahead of the features that use them,
# so a later release needs no volume migration to get its directories.
mkdir -p "${KEY_DIR}" "${DATA_DIR}/uploads" "${DATA_DIR}/plugins" \
  "${DATA_DIR}/themes" 2>/dev/null || true

if [ ! -w "${DATA_DIR}" ]; then
  fail "${DATA_DIR} is not writable by uid $(id -u). A named volume inherits the image's ownership; a bind mount does not, so a host directory has to be chowned to that uid first."
fi

chmod 700 "${KEY_DIR}"

# --- 2. the field encryption key --------------------------------------------
# Generates one on a genuine first boot, and refuses when the database already
# holds data: a fresh key there would make every encrypted field permanently
# unreadable.
node /app/docker/first-boot.mjs

# --- 3. schema migrations ---------------------------------------------------
log "applying database migrations"
"${PRISMA}" migrate deploy

# --- 4. the job queue schema ------------------------------------------------
# The runtime role holds no CREATE privilege, so pg-boss cannot install this
# itself; the owner does it here and the application starts with pg-boss
# migration disabled.
log "installing the job queue schema"
node scripts/install-job-schema.mjs

# --- 5. the runtime role ----------------------------------------------------
# Two roles, because a table owner can ALTER TABLE ... DISABLE TRIGGER and walk
# straight past the append-only guards on the statutory registers. Skipped when
# no password is supplied, which is how an operator managing the role by hand
# opts out.
if [ -n "${RUNTIME_DB_PASSWORD:-}" ]; then
  log "constraining the application database role"
  psql --quiet --no-psqlrc --set ON_ERROR_STOP=on "${DATABASE_URL}" \
    -f prisma/sql/harden-runtime-role.sql
elif [ "${NODE_ENV:-production}" = "production" ] && [ -z "${DATABASE_URL_RUNTIME:-}" ]; then
  fail "Neither RUNTIME_DB_PASSWORD nor DATABASE_URL_RUNTIME is set. In production the application must not connect as the schema owner: the owner can disable the triggers that keep the member register and the audit log append-only. Set RUNTIME_DB_PASSWORD and let this entrypoint create the role, or create the role yourself and set DATABASE_URL_RUNTIME."
fi

# --- 6. the application -----------------------------------------------------
log "starting"
exec "$@"

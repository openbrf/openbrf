#!/bin/sh
# Container entrypoint. Everything a deploy needs, in the one order that is
# safe, before the application takes over as pid 1's child.
#
#   1. the database connection URLs are assembled
#   2. the data volume exists and is writable
#   3. a field encryption key exists (ADR 0004)
#   4. the schema is migrated, as the owner
#   5. the job queue schema is installed, as the owner
#   6. the runtime role is created and constrained, as the owner
#   7. the owner's credentials are dropped, and the application starts as the
#      runtime role
#
# Steps 4 to 6 are idempotent and run on every start, so an upgrade is
# `docker compose -f docker-compose.prod.yml --env-file .env.production pull`
# followed by the same `up -d` that started the instance, and nothing else.

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

# --- 1. the connection URLs -------------------------------------------------
# Built from the parts, because a password is a URL component: one holding :,
# /, @, ? or # has to be percent-encoded, and the compose file that supplies it
# cannot encode anything. A URL that is already set is left alone, which is how
# an operator points the instance at a database they manage themselves.
if [ -z "${DATABASE_URL:-}" ] && [ -n "${POSTGRES_PASSWORD:-}" ]; then
  DATABASE_URL="$(node /app/docker/database-url.mjs owner)"
  export DATABASE_URL
fi

if [ -z "${DATABASE_URL_RUNTIME:-}" ] && [ -n "${RUNTIME_DB_PASSWORD:-}" ]; then
  DATABASE_URL_RUNTIME="$(node /app/docker/database-url.mjs runtime)"
  export DATABASE_URL_RUNTIME
fi

if [ -z "${DATABASE_URL:-}" ]; then
  fail "Neither DATABASE_URL nor POSTGRES_PASSWORD is set. One of the two has to be: the first points at the schema owner, which is the role that runs migrations, and the second lets this entrypoint build that connection itself."
fi

# --- 2. the data volume -----------------------------------------------------
# uploads, plugins and themes are created ahead of the features that use them,
# so a later release needs no volume migration to get its directories.
mkdir -p "${KEY_DIR}" "${DATA_DIR}/uploads" "${DATA_DIR}/plugins" \
  "${DATA_DIR}/themes" 2>/dev/null || true

if [ ! -w "${DATA_DIR}" ]; then
  fail "${DATA_DIR} is not writable by uid $(id -u). A named volume inherits the image's ownership; a bind mount does not, so a host directory has to be chowned to that uid first."
fi

chmod 700 "${KEY_DIR}"

# --- 3. the field encryption key --------------------------------------------
# Generates one on a genuine first boot, and refuses when the database already
# holds data: a fresh key there would make every encrypted field permanently
# unreadable.
node /app/docker/first-boot.mjs

# --- 4. schema migrations ---------------------------------------------------
log "applying database migrations"
"${PRISMA}" migrate deploy

# --- 5. the job queue schema ------------------------------------------------
# The runtime role holds no CREATE privilege, so pg-boss cannot install this
# itself; the owner does it here and the application starts with pg-boss
# migration disabled.
log "installing the job queue schema"
node scripts/install-job-schema.mjs

# --- 6. the runtime role ----------------------------------------------------
# Two roles, because a table owner can ALTER TABLE ... DISABLE TRIGGER and walk
# straight past the append-only guards on the statutory registers. Skipped when
# no password is supplied, which is how an operator managing the role by hand
# opts out.
if [ -n "${RUNTIME_DB_PASSWORD:-}" ]; then
  log "constraining the application database role"
  # Neither password reaches psql's arguments. An argument is in
  # /proc/<pid>/cmdline, which every process in the container can read; the
  # environment is not. The runtime password is read by the script itself with
  # \getenv, and the owner's travels in PGPASSWORD.
  #
  # A DATABASE_URL that cannot be read as a URL is refused rather than split,
  # so these two lines fail and `set -e` stops the boot. That is deliberate:
  # the alternative is psql taking the whole URL as an argument, password and
  # all.
  owner_url="$(node /app/docker/database-url.mjs without-password DATABASE_URL)"
  owner_password="$(node /app/docker/database-url.mjs password DATABASE_URL)"
  if [ -n "${owner_password}" ]; then
    PGPASSWORD="${owner_password}"
    export PGPASSWORD
  fi
  unset owner_password

  psql --quiet --no-psqlrc --set ON_ERROR_STOP=on "${owner_url}" \
    -f prisma/sql/harden-runtime-role.sql

  unset PGPASSWORD owner_url
elif [ "${NODE_ENV:-production}" = "production" ] && [ -z "${DATABASE_URL_RUNTIME:-}" ]; then
  fail "Neither RUNTIME_DB_PASSWORD nor DATABASE_URL_RUNTIME is set. In production the application must not connect as the schema owner: the owner can disable the triggers that keep the member register and the audit log append-only. Set RUNTIME_DB_PASSWORD and let this entrypoint create the role, or create the role yourself and set DATABASE_URL_RUNTIME."
fi

# --- 7. the application -----------------------------------------------------
# The owner's credentials stop here. Every step above needed them; the process
# that serves requests does not, and anything that can reach the database as the
# owner can run ALTER TABLE ... DISABLE TRIGGER and rewrite the member register
# a housing cooperative is required to be able to produce, or erase the audit
# log that is the evidence a reveal of protected personal data happened. The
# server therefore inherits DATABASE_URL_RUNTIME and neither password, so an
# application-path compromise has no owner connection to reach for.
#
# DATABASE_URL is kept only when there is no runtime connection to replace it:
# that is a development instance running the image against a single role, and
# PrismaService refuses it in production anyway.
if [ -n "${DATABASE_URL_RUNTIME:-}" ]; then
  unset DATABASE_URL
fi
unset POSTGRES_PASSWORD RUNTIME_DB_PASSWORD

log "starting"
exec "$@"

#!/bin/sh
# Container entrypoint. One image, three jobs, and never two in one container:
#
#   openbrf-entrypoint schema-owner  the schema owner created, as the
#                                    superuser, and then exit (the
#                                    schema-owner service)
#   openbrf-entrypoint migrate       the deploy steps, as the schema owner,
#                                    and then exit (the migrate service)
#   openbrf-entrypoint <command...>  the application, as the runtime role
#                                    (the app service)
#
# The deploy steps, in the one order that is safe:
#
#   1. the data volume exists and is writable
#   2. the owner's connection works and is not a superuser
#   3. a field encryption key exists (ADR 0004)
#   4. the triggers are checked and the schema is migrated
#   5. the job queue schema is installed
#   6. the runtime role is created and constrained
#
# Steps 2 to 6 need the owner's connection and none of them gets it from here:
# each runs under with-owner-url.mjs, which assembles that URL in its own
# process and passes it to one child through the environment. The owner's
# password therefore never becomes a shell variable, never reaches an argument
# and is never written to a stream that could end up in the container log.
#
# The jobs are separate containers because what a container is given, it
# keeps: the environment a container starts with belongs to every process in
# it for as long as it runs, whatever an entrypoint unsets on the way to its
# command. So the superuser's password goes to the schema-owner service and the
# owner's to the migrate service, each of which does its job and exits, and the
# application's container is never given either - and refuses to start if it
# is.
#
# Every step is idempotent and both services run on every `up`, so an upgrade
# is a newer image - `docker compose -f docker-compose.prod.yml --env-file
# .env.production pull` - followed by the same `up -d` that started the
# instance.

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

# --- the data volume --------------------------------------------------------
# uploads, plugins and themes are created ahead of the features that use them,
# so a later release needs no volume migration to get its directories.
prepare_data_dir() {
  mkdir -p "${KEY_DIR}" "${DATA_DIR}/uploads" "${DATA_DIR}/plugins" \
    "${DATA_DIR}/themes" 2>/dev/null || true

  if [ ! -w "${DATA_DIR}" ]; then
    fail "${DATA_DIR} is not writable by uid $(id -u). A named volume inherits the image's ownership; a bind mount does not, so a host directory has to be chowned to that uid first."
  fi

  chmod 700 "${KEY_DIR}"
}

# --- the schema owner -------------------------------------------------------
# Before the runtime connection check below, which is the migrate service's
# and the application's: this job neither creates nor uses that connection.
if [ "${1:-}" = "schema-owner" ]; then
  log "creating the schema owner"
  node /app/docker/schema-owner.mjs
  log "the schema owner is in place"
  exit 0
fi

# --- the runtime connection -------------------------------------------------
# Checked first in both jobs, because it decides whether either can do anything
# useful: the application must not connect as the schema owner, which can
# disable the triggers that keep the member register and the audit log
# append-only, and in production there is no other connection to fall back on.
if [ "${NODE_ENV:-production}" = "production" ] \
  && [ -z "${RUNTIME_DB_PASSWORD:-}" ] && [ -z "${DATABASE_URL_RUNTIME:-}" ]; then
  fail "Neither RUNTIME_DB_PASSWORD nor DATABASE_URL_RUNTIME is set. In production the application must not connect as the schema owner: the owner can disable the triggers that keep the member register and the audit log append-only. Set RUNTIME_DB_PASSWORD and let the migrate service create the role, or create the role yourself and set DATABASE_URL_RUNTIME."
fi

# The runtime role's name, RUNTIME_DB_ROLE or openbrf_app. Roles belong to the
# whole PostgreSQL server, so on a server several instances share each names
# its own, and a name that cannot be one - not a plain lower-case identifier,
# one PostgreSQL reserves, or the owner's - stops either job here, before
# anything connects, rather than in step 6 after the migrations have run.
node /app/docker/database-url.mjs check-runtime-role

# --- the deploy steps -------------------------------------------------------
if [ "${1:-}" = "migrate" ]; then
  # The owner's URL is deliberately not built here. Every step below that needs
  # it runs under with-owner-url.mjs, which assembles it inside the process that
  # uses it - so it is never printed, never a shell variable and never an
  # argument. A DATABASE_URL that is already set is used as given, which is how
  # an operator points the instance at a database they manage themselves.
  if [ -z "${DATABASE_URL:-}" ] && [ -z "${OWNER_DB_PASSWORD:-}" ]; then
    fail "Neither DATABASE_URL nor OWNER_DB_PASSWORD is set. One of the two has to be: the first points at the schema owner, which is the role that runs migrations, and the second lets this entrypoint build that connection itself."
  fi

  # 1. the data volume
  prepare_data_dir

  # 2. the owner. Also where the database is waited for.
  node /app/docker/with-owner-url.mjs node /app/docker/check-schema-owner.mjs

  # 3. the field encryption key. Generates one on a genuine first boot, and
  # refuses when the database already holds data: a fresh key there would make
  # every encrypted field permanently unreadable.
  node /app/docker/with-owner-url.mjs node /app/docker/first-boot.mjs

  # 4. schema migrations. A trigger fires for whoever writes its table, and
  # the migrations write as the owner, so the triggers in public and pgboss,
  # and the roles that could replace one, are checked before anything runs.
  log "checking the triggers the migrations would fire"
  node /app/docker/with-owner-url.mjs node scripts/check-triggers.mjs
  log "applying database migrations"
  node /app/docker/with-owner-url.mjs "${PRISMA}" migrate deploy

  # 5. the job queue schema. The runtime role holds no CREATE privilege, so
  # pg-boss cannot install this itself; the owner does it here and the
  # application starts with pg-boss migration disabled.
  log "installing the job queue schema"
  node /app/docker/with-owner-url.mjs node scripts/install-job-schema.mjs

  # 6. the runtime role. Two roles, because a table owner can ALTER TABLE ...
  # DISABLE TRIGGER and walk straight past the append-only guards on the
  # statutory registers. Skipped when no password is supplied, which is how an
  # operator managing the role by hand opts out.
  if [ -n "${RUNTIME_DB_PASSWORD:-}" ]; then
    log "constraining the application database role"
    # Neither password reaches psql's arguments, and neither is a variable in
    # this shell: harden-runtime-role.mjs splits the owner's URL in its own
    # process and passes the password to psql in PGPASSWORD, while the runtime
    # password is read by the SQL itself with \getenv.
    #
    # A DATABASE_URL that cannot be read as a URL is refused there rather than
    # split, so this line fails and `set -e` stops the deploy. That is
    # deliberate: the alternative is psql taking the whole URL as an argument,
    # password and all.
    node /app/docker/with-owner-url.mjs node /app/docker/harden-runtime-role.mjs
  fi

  log "the database is ready for the application"
  exit 0
fi

# --- the application --------------------------------------------------------
# The schema owner's credentials belong to the migrate service alone, and the
# superuser's to the database container and the schema-owner service. Given to this container, either would
# stay with it for as long as it runs, and anything that reaches the database
# as the owner or the superuser can disable the triggers that keep the member
# register and the audit log append-only. So a configuration that hands one
# over is refused here, by name, rather than accepted with an unset that could
# not take it back.
for owner_variable in OWNER_DB_PASSWORD POSTGRES_PASSWORD; do
  eval "owner_value=\${${owner_variable}:-}"
  if [ -n "${owner_value}" ]; then
    case "${owner_variable}" in
      POSTGRES_PASSWORD)
        fail "POSTGRES_PASSWORD is set in the application's container. It is the database superuser's password and belongs to the db and schema-owner services only (docker-compose.prod.yml): remove it from this service's environment."
        ;;
      *)
        fail "${owner_variable} is set in the application's container. The schema owner's credentials belong to the migrate service only (docker-compose.prod.yml): remove it from this service's environment."
        ;;
    esac
  fi
done
unset owner_value

# DATABASE_URL is the owner's connection wherever a runtime one exists beside
# it. Alone, outside production, it is a development instance running the
# image against a single role, which is left to work.
if [ -n "${DATABASE_URL:-}" ] \
  && { [ -n "${DATABASE_URL_RUNTIME:-}" ] || [ -n "${RUNTIME_DB_PASSWORD:-}" ]; }; then
  fail "DATABASE_URL is set in the application's container beside the runtime connection. It is the schema owner's, and belongs to the migrate service only (docker-compose.prod.yml): remove it from this service's environment."
fi

# The one URL that is printed and read back. The server is exec'd from this
# shell, so its connection has to be an exported variable, and a child process
# cannot put one in its parent's environment any other way. It carries the
# runtime role's password, which the server holds by design and which owns
# nothing.
#
# Built from the parts, because a password is a URL component: one holding :,
# /, @, ? or # has to be percent-encoded, and the compose file that supplies it
# cannot encode anything. A URL that is already set is left alone.
if [ -z "${DATABASE_URL_RUNTIME:-}" ] && [ -n "${RUNTIME_DB_PASSWORD:-}" ]; then
  DATABASE_URL_RUNTIME="$(node /app/docker/database-url.mjs runtime)"
  export DATABASE_URL_RUNTIME
fi
unset RUNTIME_DB_PASSWORD

prepare_data_dir

log "starting"
exec "$@"

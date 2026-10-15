#!/usr/bin/env bash
# Pulls the pinned Semgrep image for .github/workflows/semgrep.yml and prints
# the reference to run, which is the only thing it writes to stdout.
#
#   SEMGREP_IMAGE=$(scripts/pull-semgrep-image.sh \
#     "$(node scripts/check-image-pins.mjs --semgrep-image)" \
#     "$(node scripts/ci-images.mjs refs | jq -r .semgrep.pull)")
#
# Pulled through Google's mirror of Docker Hub, which does not limit anonymous
# pulls per address as Docker Hub does on runners whose addresses everyone
# else's CI shares. The pin itself stays on Docker Hub, where Dependabot reads
# the tags; the digest is the one Docker Hub serves under the tag, and the
# mirror serves the same one. A digest the mirror has not cached yet (a fresh
# Dependabot bump) falls back to CI's own copy of it in the GitHub Container
# Registry, the second argument, rather than failing the scan. That copy is
# pulled with the job's token, which is not metered, and not from Docker Hub,
# which is. .github/workflows/ci-images.yml makes the copy when a push changes
# the pin, and ci-images-pr.yml when a fork's pull request does, both at the
# same time as this scan starts, so the pull is retried until the copy is there
# (COPY_ATTEMPTS times, COPY_INTERVAL seconds apart).
#
# What a failed pull says is not enough to decide that. Docker reports a
# missing digest as "manifest unknown" or, with the containerd image store, as
# "failed to resolve reference ...: not found", and the containerd form is
# what any HTTP 404 turns into, whatever the registry said. So a failed pull is
# confirmed against the mirror: the registry API is asked for the digest, and
# only a transfer that completed with HTTP 404 and a JSON body whose
# errors[].code is MANIFEST_UNKNOWN, the registry's own word for a manifest it
# does not have, falls back. Anything else (a 404 with another code, a body
# that cut off or is not JSON, an outage, a timeout, a refused connection)
# fails, so that a lasting mirror problem is a red check someone reads and not
# every run quietly waiting on the fallback. The mirror answers
# MANIFEST_UNKNOWN for an unknown repository too, but the guard insists on
# semgrep/semgrep.
#
# The copy must be the pin in another registry: the same tag and digest, so
# that whichever image the scan runs is the one that was pinned.
#
# Whatever the mirror or Docker says is not ours to trust: the runner reads
# workflow commands (`::error::...`, `::add-mask::...`, `::set-output ...`) from
# every line a step writes, so a hostile mirror could issue them through a
# pull error or a response body. Those texts are logged between
# `::stop-commands::<token>` and `::<token>::`, a token drawn per call so the
# text cannot know it, and the log still shows them.
#
# MIRROR_HOST and MIRROR_API_SCHEME exist so that scripts/pull-semgrep-image.test.mjs
# can point the probe at a server of its own, and COPY_INTERVAL so that it need
# not wait; the workflow sets none of them.
set -euo pipefail

DOCKER_HUB_IMAGE="${1:-}"
CI_COPY="${2:-}"
MIRROR_HOST="${MIRROR_HOST:-mirror.gcr.io}"
MIRROR_API_SCHEME="${MIRROR_API_SCHEME:-https}"
COPY_ATTEMPTS="${COPY_ATTEMPTS:-30}"
COPY_INTERVAL="${COPY_INTERVAL:-20}"

# Writes its arguments to stderr as text that cannot issue workflow commands.
log_untrusted() {
  local token
  token=$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')
  printf '::stop-commands::%s\n%s\n::%s::\n' "$token" "$*" "$token" >&2
}

# Empty output would make every later line pull or run nothing sensible, so it
# stops here with a message instead.
if [ -z "$DOCKER_HUB_IMAGE" ]; then
  echo "::error::scripts/check-image-pins.mjs --semgrep-image printed no image." >&2
  exit 1
fi

# The caller is the pin guard, which only prints a reference of this shape, but
# the script should not rely on that: what it is given ends up in a registry
# URL and on a docker command line. Checked before anything touches the
# network. The tag follows Docker's grammar: a word character first, then word
# characters, dots and dashes, 128 in all.
SEMGREP_IMAGE_PATTERN='^semgrep/semgrep:[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}@sha256:[0-9a-f]{64}$'
if ! [[ "$DOCKER_HUB_IMAGE" =~ $SEMGREP_IMAGE_PATTERN ]]; then
  echo "::error::Expected a pinned reference of the form semgrep/semgrep:<tag>@sha256:<64 hex digits>; the argument is logged below." >&2
  log_untrusted "$DOCKER_HUB_IMAGE"
  exit 1
fi

# A registry and repository path, then semgrep and the pin's own tag and
# digest. Also checked before anything touches the network, so that a missing
# or mismatched copy fails every run and not only the one that falls back.
REGISTRY_PATH_PATTERN='^[a-z0-9]+([.-][a-z0-9]+)*(:[0-9]+)?(/[a-z0-9]+([._-][a-z0-9]+)*)+$'
if [ "${CI_COPY##*/semgrep:}" != "${DOCKER_HUB_IMAGE#semgrep/semgrep:}" ] \
  || ! [[ "${CI_COPY%/semgrep:*}" =~ $REGISTRY_PATH_PATTERN ]]; then
  echo "::error::Expected CI's copy of ${DOCKER_HUB_IMAGE} as <registry>/<path>/semgrep:<the same tag and digest>; the argument is logged below." >&2
  log_untrusted "$CI_COPY"
  exit 1
fi

# Everything but the image reference goes to stderr: the caller captures stdout.
MIRROR_IMAGE="${MIRROR_HOST}/${DOCKER_HUB_IMAGE}"
if PULL_OUTPUT=$(docker pull "$MIRROR_IMAGE" 2>&1); then
  log_untrusted "$PULL_OUTPUT"
  echo "$MIRROR_IMAGE"
  exit 0
fi
log_untrusted "$PULL_OUTPUT"

REPOSITORY=${DOCKER_HUB_IMAGE%%[:@]*}
DIGEST=${DOCKER_HUB_IMAGE##*@}
BODY_FILE=$(mktemp)
trap 'rm -f "$BODY_FILE"' EXIT

# No `|| true`: a probe that did not complete says nothing about the manifest,
# and curl's exit status is what tells a cut-off transfer (18) from an answer.
CURL_STATUS=0
HTTP_STATUS=$(curl --silent --show-error --max-time 30 \
  --output "$BODY_FILE" --write-out '%{http_code}' \
  --header 'Accept: application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json' \
  "${MIRROR_API_SCHEME}://${MIRROR_HOST}/v2/${REPOSITORY}/manifests/${DIGEST}") || CURL_STATUS=$?

if [ "$CURL_STATUS" -ne 0 ]; then
  echo "::error::The registry probe on ${MIRROR_HOST} did not complete (curl exit ${CURL_STATUS}); not falling back to CI's copy." >&2
  exit 1
fi

# errors[].code, and not the text anywhere in the body: another error's
# message can quote MANIFEST_UNKNOWN. A body that is not JSON, or has no
# errors array, is not a match.
if [ "$HTTP_STATUS" = "404" ] && jq -e '
      (.errors | type) == "array"
      and any(.errors[]; type == "object" and .code == "MANIFEST_UNKNOWN")
    ' "$BODY_FILE" > /dev/null 2>&1; then
  echo "::warning::${MIRROR_HOST} has not cached ${DOCKER_HUB_IMAGE}; pulling CI's copy of it, ${CI_COPY}." >&2
  ATTEMPT=1
  until COPY_OUTPUT=$(docker pull "$CI_COPY" 2>&1); do
    log_untrusted "$COPY_OUTPUT"
    if [ "$ATTEMPT" -ge "$COPY_ATTEMPTS" ]; then
      echo "::error::${CI_COPY} could not be pulled in ${COPY_ATTEMPTS} attempts. ci-images.yml copies a pin a push changes, and ci-images-pr.yml one a fork's pull request changes; their runs say why there is no copy." >&2
      exit 1
    fi
    ATTEMPT=$((ATTEMPT + 1))
    sleep "$COPY_INTERVAL"
  done
  log_untrusted "$COPY_OUTPUT"
  # A warning alone is easy to miss, and on main it means the mirror lags a pin
  # that has already merged. Written after the pull, so that a failed pull
  # does not leave a summary claiming the scan used the copy.
  echo "${MIRROR_HOST} had not cached \`${DOCKER_HUB_IMAGE}\` (MANIFEST_UNKNOWN); the Semgrep scan pulled CI's copy of it, \`${CI_COPY}\`." >> "${GITHUB_STEP_SUMMARY:-/dev/null}"
  echo "$CI_COPY"
  exit 0
fi

log_untrusted "Registry answer for ${DIGEST} (HTTP ${HTTP_STATUS}): $(head -c 300 "$BODY_FILE")"
echo "::error::${MIRROR_HOST} failed for a reason other than a missing manifest; not falling back to CI's copy." >&2
exit 1

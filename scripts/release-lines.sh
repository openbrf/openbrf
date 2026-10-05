#!/usr/bin/env bash
# Which release lines a release tag leads, read from the tags in this clone.
#
#   scripts/release-lines.sh v0.1.2
#   moveMinor=true
#   moveMajor=false
#   latest=true
#
# A patch to an older line never moves a newer line's tag. X.Y moves with the
# highest X.Y.Z; X moves only from 1.0.0 on, because before it every minor line
# waits for the association's choice; and the release is GitHub's latest only
# when it is the highest of all. There is no `latest` image tag: a tag that
# moved across lines would install the upgrade an operator is meant to choose.
#
# .github/workflows/image.yml runs it as late as it can, in a clone with every
# tag, so a later release of the same line that published first is seen and
# the line is not moved back.
set -euo pipefail

tag="$1"
version="${tag#v}"
minor="${version%.*}"
major="${version%%.*}"

# The highest release tag matching a pattern, by version order.
highest() {
  git tag --list "$1" | { grep -Ex 'v[0-9]+\.[0-9]+\.[0-9]+' || true; } \
    | sort -V | tail -n 1
}

move_minor=false
if [ "$(highest "v${minor}.*")" = "${tag}" ]; then move_minor=true; fi
move_major=false
if [ "${major}" -ge 1 ] && [ "$(highest "v${major}.*")" = "${tag}" ]; then
  move_major=true
fi
latest=false
if [ "$(highest 'v*')" = "${tag}" ]; then latest=true; fi

echo "moveMinor=${move_minor}"
echo "moveMajor=${move_major}"
echo "latest=${latest}"

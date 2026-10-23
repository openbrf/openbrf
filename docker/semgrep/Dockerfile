# The Semgrep image .github/workflows/semgrep.yml scans with. Never built: the
# workflow reads the image from the FROM line below and runs it directly.
#
# It lives here rather than in the workflow because a workflow can only name an
# image in a variable, which no updater reads, while Dependabot's docker
# ecosystem keeps the digest on a Dockerfile's FROM line current.
#
# Kept on Docker Hub, where Dependabot reads the tags. Google's mirror lists only
# the tags it has cached, so a pin on the mirror could miss a release. The
# workflow pulls through mirror.gcr.io instead, because Docker Hub limits
# anonymous pulls per address on runners whose addresses everyone else's CI
# shares, and from CI's own copy in the GitHub Container Registry when the
# mirror has not cached a new digest yet (scripts/ci-images.mjs). Semgrep
# publishes to no other registry. The digest is the same on all three.
FROM semgrep/semgrep:1.181.0@sha256:81474464c1f07483ba0682a44787fd93c91397419762a04abe2bafaae396304b

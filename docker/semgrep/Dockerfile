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
# shares. Semgrep publishes to no other registry. The digest is the same on both.
FROM semgrep/semgrep:1.179.0@sha256:93963d9295a366f59e4850127b1550400ee7b388f04fe144e4a1f6325d96e01b

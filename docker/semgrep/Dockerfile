# The Semgrep image .github/workflows/semgrep.yml scans with. Never built: the
# workflow reads the image from the FROM line below and runs it directly.
#
# It lives here rather than in the workflow because a workflow can only name an
# image in a variable, which no updater reads, while Dependabot's docker
# ecosystem keeps the digest on a Dockerfile's FROM line current.
#
# Pulled through Google's mirror of Docker Hub rather than from Docker Hub
# itself, which limits anonymous pulls per address on runners whose addresses
# everyone else's CI shares. Semgrep publishes to no other registry. The digest
# is the image Docker Hub serves under the same tag.
FROM mirror.gcr.io/semgrep/semgrep:1.179.0@sha256:93963d9295a366f59e4850127b1550400ee7b388f04fe144e4a1f6325d96e01b

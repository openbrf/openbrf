# Security Policy

Open BRF handles personal data for housing cooperatives, including legally protected identities. We take reports seriously and appreciate coordinated disclosure.

## Reporting a vulnerability

**Never report security issues in public issues, discussions, or PRs.**

Report privately via GitHub: **[Report a vulnerability](https://github.com/openbrf/openbrf/security/advisories/new)** under the repository's Security tab. The repository is public and private vulnerability reporting is enabled, so the form is open to anyone with a GitHub account, and the report stays private until an advisory is published.

This form is deliberately the project's only reporting channel - there are no project email addresses. It is also the private channel for other sensitive reports, such as code of conduct matters (see [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)).

Please include: affected component and version/commit, reproduction steps or a proof of concept, and your assessment of impact. You will get an acknowledgement within 5 working days.

## Coordinated disclosure

We follow a 90-day coordinated disclosure model: we aim to ship a fix well before that, credit you in the advisory (unless you prefer otherwise), and ask that you do not publish details until a fixed release is available or 90 days have passed, whichever comes first.

## Supported versions

Open BRF is pre-release. Until v1, the latest minor release line receives security fixes as patch releases, which an instance following that line (`OPENBRF_VERSION=0.1`, for example) installs with its next `pull`. Once v1 ships, this table lists which release lines receive security fixes.

| Version | Supported |
| --- | --- |
| 0.x (latest minor) | Fixes as patch releases |
| pre-release (`main`) | Best effort |

Every published image carries a build provenance attestation naming the commit and the workflow that built it. `gh attestation verify oci://ghcr.io/openbrf/openbrf:<version> --repo openbrf/openbrf` checks an image against it before it is run ([docs/deployment.md](docs/deployment.md), "Versions and upgrades").

## Scope

In scope: the Open BRF core in this organization's repositories, including the plugin/theme system and the official Docker Compose deployment.

Out of scope: third-party plugins and themes (report to their authors; catalog listings carry provenance requirements), vulnerabilities requiring a compromised host, and social engineering.

## A note on plugins

Plugins run with full process access to association data - there is no sandbox in v1, and we say so openly. The curated catalog with provenance requirements is the primary defense; treat plugin installation as granting trust. See the plugin documentation for details.

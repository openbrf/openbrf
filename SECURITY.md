# Security Policy

Open BRF handles personal data for housing cooperatives, including legally protected identities. We take reports seriously and appreciate coordinated disclosure.

## Reporting a vulnerability

**Never report security issues in public issues, discussions, or PRs.**

- **Preferred:** GitHub's private vulnerability reporting - use "Report a vulnerability" under the repository's Security tab. (Enabled when the repository is public; until then, contact the lead maintainer below.)
- **Fallback:** contact the lead maintainer, [@neeo](https://github.com/neeo), privately.

<!-- TODO: add security@ email address once project mail is set up. -->

Please include: affected component and version/commit, reproduction steps or a proof of concept, and your assessment of impact. You will get an acknowledgement within 5 working days.

## Coordinated disclosure

We follow a 90-day coordinated disclosure model: we aim to ship a fix well before that, credit you in the advisory (unless you prefer otherwise), and ask that you do not publish details until a fixed release is available or 90 days have passed, whichever comes first.

## Supported versions

Open BRF is pre-release; no versions are supported yet. Once v1 ships, this table lists which release lines receive security fixes.

| Version | Supported |
| --- | --- |
| pre-release (`main`) | Best effort |

## Scope

In scope: the Open BRF core in this organization's repositories, including the plugin/theme system and the official Docker Compose deployment.

Out of scope: third-party plugins and themes (report to their authors; catalog listings carry provenance requirements), vulnerabilities requiring a compromised host, and social engineering.

## A note on plugins

Plugins run with full process access to association data - there is no sandbox in v1, and we say so openly. The curated catalog with provenance requirements is the primary defense; treat plugin installation as granting trust. See the plugin documentation for details.

# Governance

This document describes honestly how Open BRF is run. No pretend democracy - but no hidden agenda either.

## The short version

Open BRF is a **maintainer-led project**. [Apteo AB](https://apteo.se), a Swedish company, created the project, employs its maintainers, and has the final say. Community input genuinely shapes the project; community votes do not decide it.

## Roles

- **Users** - anyone running or evaluating Open BRF. Bug reports and feature requests via issues are valued contributions.
- **Contributors** - anyone with a merged PR (code, docs, translations, themes). Requires a signed [CLA](CLA.md).
- **Maintainers** - commit and review rights across the organization. Currently: Holger Jensen ([@neeo](https://github.com/neeo)), lead maintainer.

**Becoming a maintainer:** sustained, high-quality contributions and good judgment in reviews and discussions, over months rather than weeks. Maintainers invite new maintainers; there is no application form. The path is real - the project's explicit goal is that it outlives any single company or person.

## How decisions are made

- Day-to-day technical decisions: whoever does the work, within the documented standards ([CONTRIBUTING.md](CONTRIBUTING.md), [DESIGN.md](DESIGN.md)).
- Significant decisions (architecture, public APIs, the token contract, scope): proposed and discussed in issues, decided by maintainers. Decisions are recorded in English in the relevant issue or document.
- Disagreements end with the lead maintainer's call.

## The open core boundary

This is the part most open core projects leave vague. We won't:

- **The core (this organization) is AGPL-3.0** with the [Module Exception](LICENSE-EXCEPTION.md), and free to self-host, forever. **No feature that exists in the core is ever moved behind a paywall.** The free tier is published and never retracted.
- **Paid modules** (mobile app, BankID, AI services, e-signing, and similar) are built by Apteo **as ordinary plugins against the same public API** available to every third-party developer, and live in Apteo's own repositories. What makes them paid is that they depend on Apteo's central infrastructure or carry per-instance licensing - never that the core was crippled to make room for them.
- **Paid hosting** is Apteo running unmodified Open BRF for associations that don't want to operate it themselves.
- **The [CLA](CLA.md)** grants Apteo the right to license contributions under other terms. This is what legally enables the module exception and the commercial modules that fund development. In return, the core is and remains open source under AGPL-3.0 - contributions to the core are never taken proprietary-only.

## Forks and the name

The code may be forked - that right is the product's core promise ("the association owns its data"). The **name and logo may not**: a fork must rename itself, per [TRADEMARK.md](TRADEMARK.md).

## Changing this document

By PR, decided by maintainers. Material changes to the open core boundary above are announced in release notes, not slipped into a diff.

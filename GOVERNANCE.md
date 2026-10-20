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

This is the part most open core projects leave vague. The rule is one test, applied to every module and published here:

> **Free:** everything an association can run on its own instance with no party but itself involved, except the licensed modules under (d). That includes every statutory duty (BRL, EFL, GDPR, bokföringslagen, Lag (2026:484)), every feature that exists in the core today, and the means to get its data out.
>
> **Paid:** (a) a service Apteo runs (hosting, push, pairing, AI inference); (b) a contract or account Apteo holds with a third party (BankID/Freja, signing providers, Fortnox/Visma, banks, collection agencies, app stores); (c) design work Apteo makes and sells as an optional theme; or (d) a module Apteo builds and licenses per instance, but only if it is named in the list of licensed modules in ROADMAP.md. Adding a module to that list needs a board decision and is announced in the release notes. A paid module is an ordinary plugin or theme against the public API.
>
> **Never:** a statutory duty, a security control (sign-in, access control, the audit log, backup and restore) or a data export is never paid. A core feature is never moved into a paid module, including one on the (d) list.

Paid modules are built by Apteo as ordinary plugins against the same public API available to every third-party developer, and live in Apteo's own repositories. Every paid module in [ROADMAP.md](ROADMAP.md) states which reason makes it paid. Beyond the rule itself:

- **The core (this organization) is AGPL-3.0** with the [Module Exception](LICENSE-EXCEPTION.md), and free to self-host, forever. **No feature that exists in the core is ever moved behind a paywall.** The free tier is published and never retracted.
- **Paid hosting** is Apteo running unmodified Open BRF for associations that don't want to operate it themselves.
- **The [CLA](CLA.md)** grants Apteo the right to license contributions under other terms. This is what legally enables the module exception and the commercial modules that fund development. In return, the core is and remains open source under AGPL-3.0 - contributions to the core are never taken proprietary-only.

## Forks and the name

The code may be forked - that right is the product's core promise ("the association owns its data"). The name and logo are not part of that right: forks are asked to rename themselves, per the [name and logo policy](TRADEMARK.md).

## Changing this document

By PR, decided by maintainers. Material changes to the open core boundary above are announced in release notes, not slipped into a diff.

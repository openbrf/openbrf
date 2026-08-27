# Open BRF

Open source, self-hostable platform for Swedish housing cooperatives (bostadsrättsföreningar, "BRF").

**Föreningen äger sin data - the association owns its data.** Open BRF gives a BRF board one system for the statutory member and apartment registers, communication, documents, and issue reporting - with no lock-in, no binding period, and Swedish law built in. Self-hosting is free, forever.

> **Status: pre-release, not yet usable.** Open BRF is under active development toward a first public release (v1, planned Q1 2027), with a pilot in a real association in December 2026. There is no user interface yet: the foundations are built and tested, but nothing here can run an association today. APIs, schemas, and documents are still moving. See [ROADMAP.md](ROADMAP.md) for what is actually implemented.

## What it does (v1 scope)

- Apartment-based address book and member register, with import. Contact details and personal identity numbers are encrypted at rest; names and postal addresses stay readable, because the statutory register must be searchable and printable
- The statutory registers under Swedish law: the member register (public on request) and the confidential apartment register, kept strictly separate
- GDPR engine: configurable retention and purging, data subject access reports, legal hold, consents, masking of protected personal data
- News and mailings, document archive, issue reporting with photos
- Roles for board members, residents, and external property managers
- Sign-in with passwords, magic links, passkeys (WebAuthn), and TOTP
- Swedish + English UI (full i18n), light + dark themes, and a WordPress-like plugin and theme system

Resource booking follows in v1.1. General meetings (stämma), board email, and simple finances are planned core features.

## Tech stack

TypeScript end to end. NestJS (Fastify) API, React 19 SPA (Vite, TanStack Router + Query, shadcn/ui, Tailwind CSS), PostgreSQL + Prisma, pg-boss job queue, Better Auth. Monorepo with pnpm workspaces + Turborepo. Deployed with Docker Compose - one instance per association. Node 26; nothing in this repository may require Bun.

## Project documents

| Document | What it covers |
| --- | --- |
| [ROADMAP.md](ROADMAP.md) | What is built, what is not, and what "usable" will mean |
| [CONTRIBUTING.md](CONTRIBUTING.md) | How to contribute: language policy, PR process, coding standards, tests, AI policy |
| [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) | Community standards (Contributor Covenant 2.1) |
| [GOVERNANCE.md](GOVERNANCE.md) | Who decides what, and how to become a maintainer |
| [SECURITY.md](SECURITY.md) | How to report vulnerabilities |
| [GLOSSARY.md](GLOSSARY.md) | Canonical Swedish-English mapping of domain terms |
| [DESIGN.md](DESIGN.md) | The "Porttavlan" design system - required reading for UI changes |
| [PRODUCT.md](PRODUCT.md) | Product scope, users, and principles |
| [TRADEMARK.md](TRADEMARK.md) | Name and logo policy - fork the code, not the name |
| [CLA.md](CLA.md) | Contributor License Agreement |

## Language

Everything in this repository is in English: code, comments, documentation, commit messages, pull requests, and release notes. The only Swedish in the codebase lives in the `sv` translation files and in domain terms where Swedish law is the point - see [GLOSSARY.md](GLOSSARY.md). Issues and discussions in Swedish are welcome; maintainers reply in Swedish, and record technical decisions in English.

## License

The Open BRF core is licensed under [AGPL-3.0](LICENSE) with the [Open BRF Module Exception](LICENSE-EXCEPTION.md), which lets plugins, themes, and modules built against the documented public APIs be licensed under terms of their authors' choosing.

The "Open BRF" name and logo identify the official project; how they may be used is described in the [name and logo policy](TRADEMARK.md).

## Commercial services

[Apteo AB](https://apteo.se) is the maintainer of Open BRF and funds development through hosting, paid modules (built as ordinary plugins against the same public API available to everyone), and related services. The core is open source and free to self-host; no core feature is ever moved behind a paywall. See [GOVERNANCE.md](GOVERNANCE.md) for how the boundary works.

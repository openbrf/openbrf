# Product

<!-- impeccable:product-schema 1 -->

Derived from the confirmed project plan v1.0 and decision log in Obsidian ("Interna projekt/Open BRF/"), approved by Holger 2026-08-27. Decision numbers (#N) reference the decision log.

## Platform

web

## Stack

TypeScript 100 % (#22). NestJS with Fastify adapter (#23). React 19 SPA via Vite, no SSR; TanStack Router + Query, shadcn/ui, Tailwind (#24). PostgreSQL + Prisma + pg-boss (#25-26). Better Auth: password, magic link, passkeys/WebAuthn, TOTP, OIDC (#26, #29). Monorepo: pnpm workspaces + Turborepo (apps/api, apps/web, packages/shared, packages/i18n, packages/moduler). Node LTS (24 now, 26 after Oct 2026); nothing may require Bun (#33). Docker Compose deployment (#32). Mobile app later via Capacitor wrapping the same web build (#30).

## Users

- **Primary: BRF board members** (styrelse) in Swedish housing cooperatives - volunteers, often non-technical, doing administration in evenings/weekends. Core segment: small associations of 3-30 apartments (~60 % of Sweden's ~30 000 BRFs) that today overpay or juggle 2-4 separate subscriptions.
- **Residents** (members and non-members: partners, children 13+, tenants) - check news, book resources, report issues; mostly mobile usage.
- **External property managers** (förvaltare/vicevärd) - limited role: issue handling only, no address book access (#11).
- **Self-hosters** - technically capable individuals (often a board member) running the platform via Docker Compose; credibility channel and funnel.

## Product Purpose

Open source, self-hostable platform for Swedish housing cooperatives (bostadsrättsföreningar): member/apartment register, communication, documents, issue reporting, and over time booking, general meetings (stämma), and simple finances. Free to self-host; Apteo AB is maintainer and earns revenue on hosting, paid modules, AI services, and the mobile app (FreeScout model, improved). Success: pilot in own BRF Dec 2026, public v1 Q1 2027.

## Positioning

"Föreningen äger sin data" - the association owns its data. No lock-in, no binding period, open source (AGPL-3.0 core with module exception), Swedish law built in (bostadsrättslagen, GDPR two-tier archive model, Lantmäteriet register 2027). No competitor can match the exit right without cannibalizing their lock-in model. The only open source BRF platform; the field is verifiably empty.

## Operating Context

- One instance per association (#28); everything sits behind login. The public mini-site is a later core feature.
- Legally mandated registers shape the UI: the member register (medlemsförteckning) is public on request; the apartment register (lägenhetsförteckning: liens, share capital, personal ID numbers) is confidential - views must never be blended (#21).
- Statutory archive tier is append-only with a 7-year retention lock; service tier has configurable purging after move-out.
- Protected personal data (skyddade personuppgifter) must be masked in all public views, exports, and lists, with access logging.
- Board work is episodic and duty-driven; residents' use is occasional and mobile-first.
- Full i18n sv + en in v1: all code and keys in English, no hardcoded strings, i18next everywhere (#34).
- Plugin system is a v1 core feature: WordPress-like install via admin UI from a curated catalog; themes are plugins delivering token sets (#35, #40).

## Capabilities and Constraints

- Core v1: encrypted apartment-based address book with import, members + non-members with own accounts, move-in/out automation, statutory registers per BRL, GDPR engine (purging, data subject access report per person, legal hold, consents), news/mailings, document archive, issue reporting with photos, roles incl. property manager, passkey auth, sv/en, plugin system.
- v1.1: basic resource booking + event calendar. Later core: general meeting (no postal voting - legally prohibited, BRL 9:14), board email, simple finances, Lantmäteriet export (legal deadline Dec 2027).
- Paid modules (built as ordinary plugins against the public API): mobile app, BankID login (Open BRF ID), AI package, e-signing (Sign), Import Pro, parking share, premium themes.
- Theming: theme engine in core, light + dark from the start, fully token-based (CSS custom properties, data-theme attribute, follows prefers-color-scheme with per-user override) (#39-40). Components reference only tokens, never hex.
- Personal ID numbers only where clearly justified, never in public views. Children's accounts: own consent from age 13.

## Brand Commitments

- Working name "Open BRF"; a real brandable name is chosen before public launch (#2) - avoid deep bake-in of the working name in design assets.
- Voice: trygg, saklig, varm - neighborhood, not playground. No emoji in UI, no bouncy playfulness (established in design language v0.1; visual direction itself is under re-evaluation).
- Open source credibility is part of the brand: what the community sees must feel like a well-maintained, serious OSS project.

## Evidence on Hand

- Market analysis of ~20 Swedish competitors with prices and weaknesses; OSS landscape scan (field empty); legal/GDPR research with statute references - all in Obsidian "Interna projekt/Open BRF/Research/".
- Design language v0.1 "Skandinavisk värme" (fastställd 2026-08-27, now under re-evaluation): Obsidian "Designsprak.md" + Claude Design project "Open BRF Designspråk" (4 pages: tokens, components, address book desktop 1440x900, resident mobile 390x844).
- No customers, testimonials, or case studies yet - do not fabricate. Pilot association is Holger's own BRF.

## Product Principles

1. **The association owns its data** - exit, export, and transparency are features, never afterthoughts.
2. **Generous, published, never-retracted free tier** - paid is what requires Apteo's central infrastructure, never a walled-off core feature.
3. **Swedish law is the spec** - BRL/EFL/GDPR requirements are hard constraints that shape data model and UI states (masking, retention, register separation).
4. **Tokens before pixels** - every visual value flows through the theme engine; a theme plugin can restyle everything.
5. **Boards are volunteers** - clarity and low cognitive load beat feature density; the register must be trustworthy at a glance (registerklass).

## Accessibility & Inclusion

Broad age span among board members and residents (retirees included): high contrast for data-dense register views, minimum 44 px touch targets on mobile, dark mode from start, WCAG-conscious component choices. No formal certification requirement established yet.

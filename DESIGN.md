---
name: Open BRF
description: Design system "Porttavlan" - the Swedish stairwell name board elevated to interface
colors:
  bg: "#EFEDE7"
  surface: "#FFFFFF"
  surface-2: "#E6E3DB"
  ink: "#26272A"
  ink-2: "#616269"
  line: "#DBD8CF"
  line-strong: "#B8B5AC"
  tavla: "#1C1D1F"
  tavla-2: "#26272B"
  tavla-ink: "#F4F2EC"
  tavla-ink-2: "#A5A6AA"
  tavla-line: "#3A3C40"
  massing: "#7D5F23"
  massing-hover: "#6F571F"
  massing-tavla: "#C9A64B"
  massing-soft: "#EFE7D2"
  on-massing: "#FFFFFF"
  on-danger: "#FFFFFF"
  ok: "#366B3E"
  ok-soft: "#E2EEDF"
  warn: "#7D5615"
  warn-tavla: "#D2A257"
  warn-soft: "#F3EAD2"
  danger: "#A03329"
  danger-soft: "#F6E2DE"
  info: "#38607E"
  info-soft: "#E1EAF2"
typography:
  display:
    fontFamily: "Familjen Grotesk, Helvetica Neue, Arial, sans-serif"
    fontSize: "30px"
    fontWeight: 700
  headline:
    fontFamily: "Familjen Grotesk, Helvetica Neue, Arial, sans-serif"
    fontSize: "24px"
    fontWeight: 700
  title:
    fontFamily: "Familjen Grotesk, Helvetica Neue, Arial, sans-serif"
    fontSize: "18px"
    fontWeight: 600
  body:
    fontFamily: "Familjen Grotesk, Helvetica Neue, Arial, sans-serif"
    fontSize: "15px"
    fontWeight: 400
    lineHeight: 1.55
  label:
    fontFamily: "Familjen Grotesk, Helvetica Neue, Arial, sans-serif"
    fontSize: "13px"
    fontWeight: 600
    letterSpacing: "0.12em"
  data:
    fontFamily: "Spline Sans Mono, ui-monospace, monospace"
    fontSize: "13px"
    fontWeight: 400
rounded:
  control: "4px"
  panel: "8px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "16px"
  lg: "24px"
  xl: "32px"
  xxl: "48px"
components:
  button-primary:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.bg}"
    rounded: "{rounded.control}"
    height: "40px"
    padding: "0 18px"
  button-secondary:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    height: "40px"
    padding: "0 16px"
  button-trust:
    backgroundColor: "{colors.massing}"
    textColor: "{colors.on-massing}"
    rounded: "{rounded.control}"
    height: "40px"
    padding: "0 18px"
  button-danger:
    backgroundColor: "{colors.danger}"
    textColor: "{colors.on-danger}"
    rounded: "{rounded.control}"
    height: "40px"
    padding: "0 18px"
  skylt-chip:
    rounded: "{rounded.control}"
    height: "22px"
    padding: "0 8px"
  input:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    height: "40px"
    padding: "0 12px"
---

# Design System: Open BRF

Recorded from the built world (Claude Design project "Open BRF Designspråk v0.2 - Porttavlan", 4 artboards, seed 8fe6b948) after the finish review shipped. Values above are the LIGHT theme ("ljus"); the dark theme ("mork") redefines the same token names (see `.impeccable/design.json` extensions and the canvas). All components reference tokens via `var(--token)`, never hex.

Correction (2026-08-27, implementation): the light brass was recorded as
`#8A6D28`, which measures 4.17:1 on `--bg` and therefore fails the WCAG AA floor
this document mandates below. It is now **#7D5F23** (5.08:1 on `--bg`, 5.94:1 on
`--surface`), the value the Adressbok canvas had already adopted for link text.
White on a brass ground improves from 4.89:1 to 5.94:1 at the same time. The
contrast matrix is enforced in code (`packages/tokens`), so the palette and this
document cannot drift apart again.

Note (decisions 42-47, 2026-08-27): at implementation time the PUBLIC token contract uses prefixed English semantic names (--obrf-surface-register, --obrf-accent-trust, --obrf-status-warn, ...) versioned with semver; Porttavlan is the default THEME delivering these values, and the Swedish names in this document are its design-language vocabulary. Themes are pure data (no JS), linted for AA contrast, and may select core-maintained view variants (e.g. member register as table or cards). Mapping table and full contract: Obsidian "Research/Temasystem - temakontraktet.md".

## Overview

**Creative North Star: "Porttavlan"** - the entrance-hall name board of a Swedish apartment building: white letters on a dark felt board with aluminum rails and brass details, standing in a lime-washed stairwell. It is the physical register every resident already reads daily, elevated to interface.

The system replaces "Skandinavisk värme" v0.1 (decided 2026-08-27). It explicitly refuses two defaults: the category's friendly card-dashboard, and the warm cream + terracotta "scandi" rendition. Personality: lawful, legible, quietly proud - a membership organization's notice board, not a SaaS product.

**Key characteristics:**
- A light limewash room where the statutory register sits on a committed dark board
- Brass reserved for positions of trust (Ordförande, Ledamot, stämma actions)
- Register data on a shared monospace grid; named states with label + pattern
- Locked, enumerable token palette; a theme plugin can restyle everything

## Colors

A neutral limewash room, one dark board surface, one brass accent, four semantic laws.

### Primary
- **Mässing / Brass** (`--massing` #7D5F23 light, #C9A64B dark; `--massing-tavla` #C9A64B on the board in both themes): positions of trust, active selection, links, focus rings. Text set on a brass ground uses `--on-massing` (#FFFFFF light / #17181A dark).

### Neutral
- **Kalkputs** (`--bg` #EFEDE7 / #17181A): page ground.
- **Surface** (`--surface` #FFFFFF / #212226, `--surface-2` #E6E3DB / #2A2B30): cards, panels, table heads in the room.
- **Ink** (`--ink` #26272A / #ECEAE4, `--ink-2` #616269 / #9C9DA1): text; ink-2 passes 4.5:1 on bg and surface.
- **Lines** (`--line` #DBD8CF / #34353A, `--line-strong` #B8B5AC / #4A4B50): dividers, control borders.
- **Tavlan** (`--tavla` #1C1D1F / #101113, `--tavla-2` header row, `--tavla-ink` #F4F2EC letters, `--tavla-ink-2` muted, `--tavla-line` #3A3C40 rails): the board surface family carrying the register.

### Semantic (färg som lag)
- **Ok** (#366B3E / #7FB489, soft #E2EEDF / #223122): confirmed.
- **Warn** (#7D5615 / #D2A257, on-board `--warn-tavla` #D2A257, soft #F3EAD2 / #383019): protected persons and caution.
- **Danger** (#A03329 / #E07A6E, soft, text on ground via `--on-danger`): destructive and failures.
- **Info** (#38607E / #85ACC9, soft): neutral information.

### Named Rules
**The Color-as-Law Rule.** Every semantic color encodes exactly one rule everywhere, and register views show a visible legend. Brass means trust; it never decorates.
**The On-Board Variant Rule.** Small text on `--tavla` uses the `-tavla` variant of its color (`--massing-tavla`, `--warn-tavla`) to keep AA contrast; never the room-side value.

## Typography

**Display + Body Font:** Familjen Grotesk (Familjen STHLM, SIL OFL; fallback Helvetica Neue, Arial)
**Data Font:** Spline Sans Mono (fallback ui-monospace)

**Character:** one Swedish grotesk carries everything from board lettering to body copy - signage discipline; the mono carries all register data.

### Hierarchy
- **Display** (700, 30px): page-level headings.
- **Headline** (700, 24px) / **Title** (600, 18px): section headings.
- **Tavelrubrik / Label** (600, 13px, 0.12em letterspacing, uppercase): board headings, section labels, column heads, state signs.
- **Body** (400, 15px, 1.55): running text. **Small** 13px for metadata.
- **Data** (mono 400-500, 13-14px): apartment numbers, dates, phone numbers, personal ID, OCR - always mono, columns align character-for-character.

### Named Rules
**The Mono-Grid Rule.** All register data columns share one monospace grid; a date or lgh-nr set in the UI face is a defect.

## Reference values

Every colour, the type scale, the radii, the spacing and the board's measurements
are in [docs/design-refs/porttavlan.md](docs/design-refs/porttavlan.md), with the
deliberate divergences.

## Layout

The board topology: a fixed dark top band (64px) carries the association identity and navigation as a sign row; content lives in the light room below (20-40px padding); the register itself is a full-width dark board panel with 1px rail dividers between rows (9-12px vertical padding, 24px horizontal). The register is grouped by floor like a physical porttavla: thin group rows on `--tavla-2` ("ENTREPLAN 10XX", "PLAN 1 11XX", ...) following Lantmateriet apartment numbering. Fixed regions swap content, never position. Spacing on a 4-base scale (4/8/12/16/24/32/48). Mobile: dark board header and bottom nav frame a light room; touch targets minimum 44px.

## Elevation & Depth

Flat by conviction. Exactly one soft shadow level (`0 2px 10px rgba(28,29,31,0.08)` light / `rgba(0,0,0,0.4)` dark) on room-side cards and the board panel. No glassmorphism, no gradients; depth otherwise comes from the board/room value contrast.

## Shapes

Rectangular sign language: 4px radius on controls, inputs and skylt-chips; 8px on cards and panels; no pills anywhere. Signs (chips) on the board are outlined; in the room they are soft-filled. Dashed outline marks the Utflyttad state.

## Components

### Buttons
- **Shape:** 4px radius, 40px height (32px small).
- **Primary:** dark sign - `--ink` ground, `--bg` text ("Lägg till person").
- **Secondary:** `--surface` + `--line-strong` border.
- **Trust:** `--massing` + `--on-massing`, only for trust actions (calling a stämma).
- **Danger:** `--danger` + `--on-danger`.
- **Hover:** 150-200ms ease-out to the darker/hover token; no bounce, no glow.

### Skylt-chips (roles and states)
- 22px tall, 4px radius, 11px/600 uppercase, 0.08em.
- On the board: outline style - trust roles in `--massing-tavla`, neutral roles (Medlem, Boende, Förvaltare) in `--tavla-line`/`--tavla-ink-2`, Skyddad in `--warn-tavla` with a lock icon and masked fields, Utflyttad dashed + dimmed row + purge date.
- In the room: soft-filled (`--ok-soft`/`--ok` etc.) for statuses like Betald, Väntar, Förfallen, Utkast.

### Inputs
- `--surface` ground, `--line-strong` 1px border, 4px radius, 40px height.
- **Focus:** 2px `--massing` border, no glow. **Error:** 2px `--danger` border + message in `--danger`.

### Navigation
- Desktop: sign row in the dark top band - 13px/600 uppercase, `--tavla-ink-2` at rest, active gets `--tavla-ink` + 3px `--massing-tavla` underline; counters as small brass plates. Mobile: 4-item bottom bar on `--tavla`, active item in `--massing-tavla` with a 3px `--massing-tavla` edge on the top side, so the active state carries a shape as well as a colour.

### The Board (signature component)
The register table as a dark board: `--tavla` panel (8px radius, one shadow), a filter strip ON the board (uppercase tabs, active in `--massing-tavla` with 3px underline), `--tavla-2` header, floor group rows, and legend row, 1px `--tavla-line` rails between rows, names in 15/500 `--tavla-ink`, data columns in mono. The board footer carries the always-visible "Färg som lag" legend (left) and a register stamp in mono (right): "Utdrag ur medlemsförteckningen · YYYY-MM-DD". (v0.2.1 additions - floor grouping, on-board filters, register stamp - donated by the Stitch exploration 2026-08-27.)

## Do's and Don'ts

### Do:
- **Do** reference only `var(--token)` in components; the theme engine (light + dark, themes as plugins) must be able to restyle everything.
- **Do** keep every state labeled with text + pattern (dash, lock, dimming) - color is never the only signal.
- **Do** keep the register on the board and everyday lists (bookings, ärenden) in the room on light surfaces.
- **Do** hold WCAG AA (4.5:1) even for 13px text - this is a statutory register.

### Don't:
- **Don't** use pills, gradients, glassmorphism, extra shadow levels, or emoji.
- **Don't** use brass for anything but trust roles, trust actions, active/selected states, and the navigation count plate.
- **Don't** put personal ID numbers, masked or not, outside the register views; Skyddad rows mask contact data everywhere.
- **Don't** hardcode `#FFFFFF`/hex in components - the one recorded defect class the review caught; use `--on-massing`/`--on-danger`.

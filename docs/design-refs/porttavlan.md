# Porttavlan - design reference

The normative values of the design the interface is built from. Compare against
this file; anything that differs and is not listed under "Deliberate
divergences" is drift.

Design system: **Porttavlan v0.2.1**, address book canvas dated 2026-08-27.
The values below are that canvas and the token contract it maps onto.

## Colours

Light theme. The right-hand column is the token that carries the value in
`packages/tokens/src/porttavlan.ts`.

| Design        | Value                            | Token                     |
| ------------- | -------------------------------- | ------------------------- |
| bg            | `#EFEDE7`                        | `surface-page`            |
| surface       | `#FFFFFF`                        | `surface-raised`          |
| surface-2     | `#E6E3DB`                        | `surface-sunken`          |
| ink           | `#26272A`                        | `text-primary`            |
| ink-2         | `#616269`                        | `text-secondary`          |
| line          | `#DBD8CF`                        | `border-subtle`           |
| line-strong   | `#B8B5AC`                        | `border-strong`           |
| tavla         | `#1C1D1F`                        | `surface-register`        |
| tavla-2       | `#26272B`                        | `surface-register-raised` |
| tavla-ink     | `#F4F2EC`                        | `text-register`           |
| tavla-ink-2   | `#A5A6AA`                        | `text-register-secondary` |
| tavla-line    | `#3A3C40`                        | `border-register`         |
| massing       | `#8A6D28`                        | `accent-trust`            |
| massing-hover | `#6F571F`                        | `accent-trust-hover`      |
| massing-soft  | `#EFE7D2`                        | `accent-trust-soft`       |
| massing-tavla | `#C9A64B`                        | `accent-trust-register`   |
| ok            | `#366B3E`                        | `status-ok`               |
| ok-soft       | `#E2EEDF`                        | `status-ok-soft`          |
| warn          | `#7D5615`                        | `status-warn`             |
| warn-tavla    | `#D2A257`                        | `status-warn-register`    |
| warn-soft     | `#F3EAD2`                        | `status-warn-soft`        |
| danger        | `#A03329`                        | `status-danger`           |
| danger-soft   | `#F6E2DE`                        | `status-danger-soft`      |
| info          | `#38607E`                        | `status-info`             |
| info-soft     | `#E1EAF2`                        | `status-info-soft`        |
| shadow        | `0 2px 10px rgba(28,29,31,0.08)` | `shadow-raised`           |

The dark theme redefines the same names; its values are in `porttavlan.ts`.

## Type

| Role     | Size    | Weight  | Letter-spacing |
| -------- | ------- | ------- | -------------- |
| display  | 30px    | 700     | -              |
| headline | 24px    | 700     | -              |
| title    | 18px    | 600     | -              |
| body     | 15px    | 400     | -              |
| small    | 13px    | 400     | -              |
| label    | 13px    | 600     | 0.12em         |
| data     | 13-14px | 400-500 | -              |
| chip     | 11px    | 600     | 0.08em         |

Data is 14px for an apartment number and 13px for a date or a phone number.

Line heights: display 1.2, headline 1.3, title 1.4, body 1.55, small 1.4,
label 1.0, data 1.0. The chip carries no line height of its own.

## The band

64px tall, `surface-register` ground, 32px horizontal padding.

- Identity: 30px square, 4px radius, 1px `accent-trust-register` border; name
  14px/700/0.12em uppercase; instance name 10px/0.08em uppercase in
  `text-register-secondary`.
- Navigation: 13px/600/0.1em uppercase, full 64px height, 3px transparent bottom
  border. Active carries `text-register` and a 3px `accent-trust-register`
  bottom border.
- Count plate: 18px tall, minimum 18px wide, 4px radius,
  `accent-trust-register` ground, `surface-register` text, 11px/700, no letter
  spacing.
- Person: 30px square avatar on `surface-register-raised` with a
  `border-register` border and `accent-trust-register` initials at 12px/700;
  name 13px/600; role 10px/0.1em uppercase in `accent-trust-register` at 600.

## The board

8px radius, one shadow, `surface-register` ground.

- **House tabs**, shown when the cooperative has more than one address: 44px
  tall, 16px horizontal padding, 13px/600/0.06em, a `border-register` divider
  between tabs. Active carries a `surface-register-raised` ground and a 3px
  `accent-trust-register` inset edge on the top side.
- **Filter strip**: 12px/600/0.1em uppercase, 40px tall, 24px gap. Active
  carries `accent-trust-register` and a 3px bottom border in the same colour.
- **Column header**: `surface-register-raised` ground, 10px/24px padding,
  11px/600/0.12em uppercase.
- **Column grid**: `84px 1.6fr 170px 1.4fr 120px 120px` - apartment, name, role,
  contact, moved in, moved out.
- **Floor group row**: `surface-register-raised` ground, 5px/24px/4px padding,
  11px/700/0.14em uppercase, followed by the floor's number range in the data
  face at 11px.
- **Row**: 9px/24px padding, 1px `border-register` top rule, 15px base. The
  apartment number is in the data face at 14px, the name at 500, the role as a
  sign, and both dates in the data face at 13px.
- **Contact**: the phone number is in the data face at 13px; the address is in
  the UI face at the same size.
- **Signs**: 22px tall, 8px horizontal padding, 4px radius, 11px/600/0.08em
  uppercase, outlined. Trust roles use `accent-trust-register`, neutral roles
  `border-register` with `text-register-secondary`, protected
  `status-warn-register` with a lock. Moved out uses a dashed border and dims
  the whole row to `text-register-secondary`.
- **Legend**: `surface-register-raised` ground, 11px/0.06em uppercase, one 8px
  dot per meaning - trust, confirmed, protected, danger, information.
- **Stamp**: right-aligned in the legend row, data face at 11px, naming the
  scope and the date.

## Room chrome

- Page padding 20px vertical and 40px horizontal, with a 14px gap between
  blocks.
- Search field 320x40, 4px radius, `border-strong`.
- Secondary button 40px tall, 16px horizontal padding, `surface-raised` ground,
  `border-strong`.
- Primary button 40px tall, 18px horizontal padding, `text-primary` ground,
  `surface-page` text.
- Pagination: 32px squares on the desktop canvas, 4px radius; the current page
  uses the primary ground. The hit area is 44px minimum wherever the control is
  reachable by touch.

## Shape and spacing

|                          | Value              |
| ------------------------ | ------------------ |
| Controls, inputs, signs  | 4px radius         |
| Cards, panels, the board | 8px radius         |
| Pills                    | not used           |
| Spacing                  | 4/8/12/16/24/32/48 |
| Board rails              | 1px                |
| Touch targets            | 44px minimum       |
| Elevation                | one shadow         |

## Deliberate divergences

### `accent-trust` is `#7D5F23`, not `#8A6D28`

`#8A6D28` measures 4.17:1 on `surface-page`, below the 4.5:1 this register is
held to. The value carries links and trust labels in the room, so it is text.
`#7D5F23` is the same hue at 5.08:1. `accent-trust-register` `#C9A64B` is
unchanged and measures 7.26:1 on the board.

`packages/tokens` enforces the pair, so `#8A6D28` fails the build.

### Line heights

| Role     | Design | Implemented |
| -------- | ------ | ----------- |
| display  | 1.2    | 1.15        |
| headline | 1.3    | 1.25        |
| title    | 1.4    | 1.3         |
| small    | 1.4    | 1.5         |
| label    | 1.0    | 1.2         |
| data     | 1.0    | 1.4         |

Body is 1.55 in both. A line height of 1.0 at 13px leaves no room for descenders
in a register column, where the row below carries more of the same data.

### The stamp names the address book, not the member register

The design's stamp reads "Utdrag ur medlemsförteckningen". The address book
carries members and non-member residents together, while the member register
under BRL 9 kap. 9 § carries members only and is held available to anyone who
asks. The stamp therefore names the address book, and `stampKey` is a prop so
the member register view can pass its own.

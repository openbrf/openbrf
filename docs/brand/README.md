# The Open BRF logo

The mark is a building front: ten units wide and fourteen tall, six windows cut
through it and a door at the foot. One window is lit in brass. It is somebody's
home among the neighbours', which is what a housing cooperative is. The
wordmark beside it is "Open BRF" in Familjen Grotesk Bold, the typeface the
application itself is set in, converted to outlines so no file here needs the
font installed.

How the name and the logo may be used by others is set out in
[TRADEMARK.md](../../TRADEMARK.md). This page is about using them correctly.

## Files

| File                                                     | For                                              |
| -------------------------------------------------------- | ------------------------------------------------ |
| [openbrf-mark.svg](openbrf-mark.svg)                     | The mark on a light ground                       |
| [openbrf-mark-on-dark.svg](openbrf-mark-on-dark.svg)     | The mark on a dark ground                        |
| [openbrf-mark-mono.svg](openbrf-mark-mono.svg)           | The mark in one colour (`currentColor`)          |
| [openbrf-lockup.svg](openbrf-lockup.svg)                 | Mark and wordmark on a light ground              |
| [openbrf-lockup-on-dark.svg](openbrf-lockup-on-dark.svg) | Mark and wordmark on a dark ground               |
| [openbrf-lockup-mono.svg](openbrf-lockup-mono.svg)       | Mark and wordmark in one colour (`currentColor`) |

The client carries its own copies: the favicons in `apps/web/public` and the two
lockups in `apps/web/public/brand`, which the sign-in, activation, account
request, setup and app consent screens show. A change to the logo changes those
files in the same pull request.

## Colours

The logo takes its colours from the Porttavlan palette ([DESIGN.md](../../DESIGN.md)).

| Role                  | Light ground                   | Dark ground                   |
| --------------------- | ------------------------------ | ----------------------------- |
| Building and wordmark | `#1C1D1F` (tavla)              | `#F4F2EC` (tavla ink)         |
| Lit window            | `#C9A64B` (brass on the board) | `#7D5F23` (brass in the room) |

The window is always brass, and always the brass that reads against the
building it sits in: the light brass in a dark building, the dark brass in a
light one. In one colour the lit window is the one that is not cut through.

These values are fixed. A theme restyles the application, never the logo, and
an association's own accent colour does not reach it either.

## Drawing

The mark is drawn on a 16-unit grid: the building from (3, 1) to (13, 15),
windows of 2 by 2 units with one unit between rows and two between columns, and
a door 2 units wide and 3 tall. Every edge falls on a whole unit, so the mark is
pixel-exact at 16, 32, 48 and 64 pixels, and the favicon is the same drawing as
every other size.

The lockup is the same building at three times the size, beside the wordmark
with its cap height at twenty units and centred on the building. The wordmark
uses the typeface's own spacing; the font has no kerning pairs for these
letters.

## Using it

- **Clear space.** Keep an empty margin around the logo of at least the width of
  two windows and the gap between them: six units on the 16-unit grid, which is
  three fifths of the building's width.
- **Minimum size.** The mark at 16 pixels, the lockup at 24 pixels tall.
- **Grounds.** Use the light-ground files on the limewash page, on white and on
  photographs light enough to read dark ink against; the dark-ground files on
  the board, in the dark theme and on dark photographs.
- **Beside an association's logo.** In an association's own website and app the
  association's logo leads. Open BRF appears as the platform: the favicon, the
  screens before the application frame, and "Drivs med Open BRF" where an
  instance credits it.

Do not:

- move the lit window, light a second one, or add or remove windows;
- recolour the logo, including the window, beyond the three sets above;
- set the wordmark in another typeface or re-space it by eye;
- add outlines, shadows, gradients or rounded corners - Porttavlan has none;
- use the dark-ground files on a light ground, or the reverse.

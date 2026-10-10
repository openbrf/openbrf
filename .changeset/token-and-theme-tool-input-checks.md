---
"@openbrf/tokens": patch
"@openbrf/theme-tools": patch
---

Check theme input more strictly.

- `parseColor` returns null for an `rgb()` channel outside 0-255 or not a
  number, and `checkContrast` fails a ratio that is not a number.
- `tokensToCssDeclarations` writes only the contract's token names.
- A manifest's font family may not hold a control character, and
  `buildFontFaceStylesheet` leaves out a face it cannot write instead of
  throwing.
- `readThemeArchive` refuses a path `isPackagePath` refuses.

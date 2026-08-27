import type { PartialTokenSet, TokenSet } from "./contract.ts";

/**
 * Porttavlan: the default theme.
 *
 * Values are transcribed from DESIGN.md, which is the design system of record.
 * This file supplies VALUES for the contract; it does not define the contract.
 * A design change replaces these numbers without touching a token name, which
 * is exactly why the contract exists (decision 42): the switch from
 * "Skandinavisk varme" to "Porttavlan" would otherwise have broken every
 * third-party theme.
 *
 * The Swedish names in DESIGN.md (tavla, massing, kalkputs) are the design
 * language's vocabulary. They deliberately do not appear here.
 */

export const PORTTAVLAN_ID = "porttavlan";

/** Light mode: a limewashed room with the register on a committed dark board. */
export const PORTTAVLAN_LIGHT: TokenSet = {
  "surface-page": "#EFEDE7",
  "surface-raised": "#FFFFFF",
  "surface-sunken": "#E6E3DB",

  "text-primary": "#26272A",
  "text-secondary": "#616269",

  "border-subtle": "#DBD8CF",
  "border-strong": "#B8B5AC",

  "surface-register": "#1C1D1F",
  "surface-register-raised": "#26272B",
  "text-register": "#F4F2EC",
  "text-register-secondary": "#A5A6AA",
  "border-register": "#3A3C40",

  // DESIGN.md records the brass as #8A6D28, but that value gives only 4.17:1
  // on the page ground and so fails the AA floor the design system itself
  // mandates. The Adressbok canvas had already worked around it by setting
  // links to #7D5F23; since this contract has one trust accent serving text,
  // links, focus rings and accent grounds alike, it takes the accessible value.
  // 5.08:1 on the page, 5.94:1 on a raised surface, and it also improves white
  // text on a brass ground from 4.89:1 to 5.94:1.
  "accent-trust": "#7D5F23",
  "accent-trust-hover": "#6F571F",
  "accent-trust-soft": "#EFE7D2",
  "accent-trust-register": "#C9A64B",
  "on-accent-trust": "#FFFFFF",

  "status-ok": "#366B3E",
  "status-ok-soft": "#E2EEDF",
  "status-warn": "#7D5615",
  "status-warn-soft": "#F3EAD2",
  "status-warn-register": "#D2A257",
  "status-danger": "#A03329",
  "status-danger-soft": "#F6E2DE",
  "on-status-danger": "#FFFFFF",
  "status-info": "#38607E",
  "status-info-soft": "#E1EAF2",

  "radius-control": "4px",
  "radius-panel": "8px",
  "shadow-raised": "0 2px 10px rgba(28, 29, 31, 0.08)",

  "motion-duration": "180ms",
  "motion-easing": "ease-out",

  "font-ui":
    "'Familjen Grotesk', 'Helvetica Neue', Helvetica, Arial, sans-serif",
  "font-data":
    "'Spline Sans Mono', ui-monospace, SFMono-Regular, Menlo, monospace",
};

/**
 * Dark mode.
 *
 * Designed rather than derived: the register board goes darker than the room
 * so it stays a distinct surface, and the trust accent lightens to keep AA on
 * a dark ground. Note that on-accent-trust and on-status-danger invert to dark
 * ink, because the accents themselves become light.
 */
export const PORTTAVLAN_DARK: TokenSet = {
  "surface-page": "#17181A",
  "surface-raised": "#212226",
  "surface-sunken": "#2A2B30",

  "text-primary": "#ECEAE4",
  "text-secondary": "#9C9DA1",

  "border-subtle": "#34353A",
  "border-strong": "#4A4B50",

  "surface-register": "#101113",
  "surface-register-raised": "#1A1B1E",
  "text-register": "#F4F2EC",
  "text-register-secondary": "#9EA0A4",
  "border-register": "#303236",

  "accent-trust": "#C9A64B",
  "accent-trust-hover": "#D8B75E",
  "accent-trust-soft": "#35301E",
  "accent-trust-register": "#C9A64B",
  "on-accent-trust": "#17181A",

  "status-ok": "#7FB489",
  "status-ok-soft": "#223122",
  "status-warn": "#D2A257",
  "status-warn-soft": "#383019",
  "status-warn-register": "#D2A257",
  "status-danger": "#E07A6E",
  "status-danger-soft": "#3D2420",
  "on-status-danger": "#17181A",
  "status-info": "#85ACC9",
  "status-info-soft": "#253442",

  "radius-control": "4px",
  "radius-panel": "8px",
  "shadow-raised": "0 2px 10px rgba(0, 0, 0, 0.4)",

  "motion-duration": "180ms",
  "motion-easing": "ease-out",

  "font-ui":
    "'Familjen Grotesk', 'Helvetica Neue', Helvetica, Arial, sans-serif",
  "font-data":
    "'Spline Sans Mono', ui-monospace, SFMono-Regular, Menlo, monospace",
};

export interface ThemeModes {
  light: TokenSet;
  dark: TokenSet;
}

export const PORTTAVLAN: ThemeModes = {
  light: PORTTAVLAN_LIGHT,
  dark: PORTTAVLAN_DARK,
};

/** Named export used when a theme declares `extends: "porttavlan"`. */
export const DEFAULT_THEME_MODES: Record<string, PartialTokenSet> = {
  light: PORTTAVLAN_LIGHT,
  dark: PORTTAVLAN_DARK,
};

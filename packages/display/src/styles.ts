/**
 * The renderer's stylesheet.
 *
 * Its colours, type, shape and motion are the default theme's (Porttavlan,
 * from `@openbrf/tokens`), so a screen looks like the association's own pages,
 * and every pair it sets on another is one the token contract holds to WCAG
 * AA. Dates, times and apartment numbers are in the data face, as everywhere
 * else (DESIGN.md, the Mono-Grid Rule).
 * A screen is read from across a stairwell, so every size is a fraction of the
 * canvas's shorter side (`--obrf-display-u`, a hundredth of it), which the
 * renderer sets from the element it is mounted on.
 *
 * Every class starts with `obrf-display`, so the sheet restyles nothing of the
 * page it is mounted in.
 */
import {
  PORTTAVLAN_DARK,
  PORTTAVLAN_LIGHT,
  type TokenSet,
} from "@openbrf/tokens";

function palette(tokens: TokenSet): string {
  return [
    `--obrf-display-ground: ${tokens["surface-page"]};`,
    `--obrf-display-panel: ${tokens["surface-raised"]};`,
    `--obrf-display-ink: ${tokens["text-primary"]};`,
    `--obrf-display-muted: ${tokens["text-secondary"]};`,
    `--obrf-display-accent: ${tokens["accent-trust"]};`,
    `--obrf-display-danger: ${tokens["status-danger"]};`,
    `--obrf-display-on-danger: ${tokens["on-status-danger"]};`,
    `--obrf-display-rule: ${tokens["border-subtle"]};`,
    `--obrf-display-font: ${tokens["font-ui"]};`,
    `--obrf-display-data-font: ${tokens["font-data"]};`,
    `--obrf-display-radius-control: ${tokens["radius-control"]};`,
    `--obrf-display-radius-panel: ${tokens["radius-panel"]};`,
    `--obrf-display-motion-duration: ${tokens["motion-duration"]};`,
    `--obrf-display-motion-easing: ${tokens["motion-easing"]};`,
  ].join(" ");
}

const u = (times: number): string => `calc(var(--obrf-display-u) * ${times})`;

/**
 * The stylesheet `mountRenderer` adds to the document once, as a `<style>`
 * element with the attribute `data-obrf-display`. Exported for a page that
 * would rather serve it as a file of its own.
 */
export const DISPLAY_STYLESHEET = `
.obrf-display { --obrf-display-u: 1vmin; position: relative; width: 100%; height: 100%; overflow: hidden; background: var(--obrf-display-ground); color: var(--obrf-display-ink); font-family: var(--obrf-display-font); }
.obrf-display--light { ${palette(PORTTAVLAN_LIGHT)} color-scheme: light; }
.obrf-display--dark { ${palette(PORTTAVLAN_DARK)} color-scheme: dark; }
.obrf-display [hidden] { display: none !important; }
.obrf-display *, .obrf-display *::before, .obrf-display *::after { box-sizing: border-box; }
.obrf-display-canvas { position: absolute; left: 50%; top: 50%; width: 100%; height: 100%; transform: translate(-50%, -50%); display: flex; flex-direction: column; gap: ${u(2.5)}; padding: ${u(4)} ${u(5)}; font-size: ${u(3.4)}; line-height: 1.3; }
.obrf-display-clock { display: flex; justify-content: space-between; align-items: baseline; gap: ${u(3)}; padding-bottom: ${u(1.5)}; border-bottom: ${u(0.25)} solid var(--obrf-display-rule); color: var(--obrf-display-muted); font-size: ${u(3.6)}; }
.obrf-display-clock, .obrf-display-date, .obrf-display-when, .obrf-display-door-apartment, .obrf-display-data { font-family: var(--obrf-display-data-font); }
.obrf-display-clock-time { color: var(--obrf-display-ink); font-size: ${u(5)}; font-weight: 700; font-variant-numeric: tabular-nums; }
.obrf-display-stage { position: relative; flex: 1 1 auto; min-height: 0; overflow: hidden; }
.obrf-display-slide { display: flex; flex-direction: column; gap: ${u(2.5)}; height: 100%; min-height: 0; overflow: hidden; font-size: ${u(3.4)}; }
.obrf-display-slide--enter { animation: obrf-display-enter var(--obrf-display-motion-duration) var(--obrf-display-motion-easing); }
@keyframes obrf-display-enter { from { opacity: 0; } to { opacity: 1; } }
@media (prefers-reduced-motion: reduce) { .obrf-display-slide--enter { animation: none; } }
.obrf-display-heading { margin: 0; font-size: ${u(6.5)}; font-weight: 700; line-height: 1.1; overflow-wrap: anywhere; }
.obrf-display-subheading { margin: 0; font-size: ${u(4)}; font-weight: 700; color: var(--obrf-display-muted); }
.obrf-display-text { margin: 0; white-space: pre-line; overflow-wrap: anywhere; }
.obrf-display-muted { color: var(--obrf-display-muted); }
.obrf-display-date { margin: 0; color: var(--obrf-display-accent); font-weight: 700; }
.obrf-display-news { display: grid; grid-template-columns: minmax(0, 1fr); align-content: start; }
.obrf-display-news--picture { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); grid-template-rows: minmax(0, 1fr); gap: ${u(5)}; }
.obrf-display--portrait .obrf-display-news--picture { grid-template-columns: minmax(0, 1fr); grid-template-rows: minmax(0, 1fr) minmax(0, 1fr); }
.obrf-display-copy { display: flex; flex-direction: column; gap: ${u(2)}; min-height: 0; overflow: hidden; }
.obrf-display-picture { display: block; width: 100%; height: 100%; min-height: 0; object-fit: contain; }
.obrf-display-figure { display: flex; flex-direction: column; gap: ${u(2)}; height: 100%; margin: 0; }
.obrf-display-figure .obrf-display-picture { flex: 1 1 auto; }
.obrf-display-caption { font-size: ${u(4)}; text-align: center; }
.obrf-display-list { display: flex; flex-direction: column; gap: ${u(2)}; margin: 0; padding: 0; list-style: none; }
.obrf-display-event { display: grid; grid-template-columns: ${u(24)} minmax(0, 1fr); gap: ${u(3)}; padding-bottom: ${u(1.5)}; border-bottom: ${u(0.2)} solid var(--obrf-display-rule); }
.obrf-display-when { display: flex; flex-direction: column; color: var(--obrf-display-accent); font-weight: 700; font-variant-numeric: tabular-nums; }
.obrf-display-what { display: flex; flex-direction: column; gap: ${u(0.5)}; min-width: 0; }
.obrf-display-title { margin: 0; font-weight: 700; overflow-wrap: anywhere; }
.obrf-display-event--called-off .obrf-display-title { text-decoration: line-through; }
.obrf-display-description { margin: 0; color: var(--obrf-display-muted); font-size: ${u(2.8)}; overflow: hidden; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; }
.obrf-display-badge { align-self: flex-start; padding: 0 ${u(1)}; border-radius: var(--obrf-display-radius-control); background: var(--obrf-display-danger); color: var(--obrf-display-on-danger); font-weight: 700; }
.obrf-display-facts { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: ${u(1)} ${u(3)}; margin: 0; }
.obrf-display-facts dt { color: var(--obrf-display-muted); }
.obrf-display-facts dd { margin: 0; font-weight: 700; white-space: pre-line; overflow-wrap: anywhere; }
.obrf-display-agenda { margin: 0; padding: 0; list-style: none; columns: 2; column-gap: ${u(5)}; font-size: ${u(3)}; }
.obrf-display--portrait .obrf-display-agenda { columns: 1; }
.obrf-display-agenda li { break-inside: avoid; display: flex; gap: ${u(1.5)}; }
.obrf-display-agenda-position { min-width: ${u(4)}; color: var(--obrf-display-muted); font-variant-numeric: tabular-nums; }
.obrf-display-resources { display: grid; grid-template-columns: repeat(auto-fill, minmax(${u(52)}, 1fr)); gap: ${u(2)}; margin: 0; padding: 0; list-style: none; }
.obrf-display-resource { display: flex; flex-direction: column; gap: ${u(0.8)}; padding: ${u(1.5)} ${u(2)}; border-radius: var(--obrf-display-radius-panel); background: var(--obrf-display-panel); }
.obrf-display-day { display: flex; margin: 0; flex-wrap: wrap; gap: ${u(0.5)} ${u(1.5)}; font-size: ${u(2.8)}; }
.obrf-display-day-label { min-width: ${u(14)}; color: var(--obrf-display-muted); }
.obrf-display-busy { font-weight: 700; font-variant-numeric: tabular-nums; }
.obrf-display-table { width: 100%; border-collapse: collapse; }
.obrf-display-table th, .obrf-display-table td { padding: ${u(0.8)} ${u(1.5)}; border-bottom: ${u(0.2)} solid var(--obrf-display-rule); text-align: left; vertical-align: top; overflow-wrap: anywhere; }
.obrf-display-table th { color: var(--obrf-display-muted); }
.obrf-display-doors { display: grid; grid-template-columns: repeat(auto-fill, minmax(${u(30)}, 1fr)); gap: ${u(1.5)}; margin: 0; padding: 0; list-style: none; font-size: ${u(2.8)}; }
.obrf-display-door { display: flex; flex-direction: column; padding: ${u(1)} ${u(1.5)}; border-radius: var(--obrf-display-radius-panel); background: var(--obrf-display-panel); }
.obrf-display-door-apartment { font-weight: 700; }
.obrf-display-message { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: ${u(3)}; height: 100%; text-align: center; }
.obrf-display-message-title { margin: 0; font-size: ${u(7)}; font-weight: 700; }
.obrf-display-empty { display: flex; align-items: center; justify-content: center; height: 100%; margin: 0; color: var(--obrf-display-muted); font-size: ${u(4)}; }
.obrf-display-message-detail { max-width: 40ch; margin: 0; color: var(--obrf-display-muted); font-size: ${u(4)}; }
.obrf-display-note { position: absolute; right: ${u(2)}; bottom: ${u(1.2)}; color: var(--obrf-display-muted); font-size: ${u(2.2)}; }
.obrf-display-off { position: absolute; inset: 0; z-index: 1; background: black; }
`;

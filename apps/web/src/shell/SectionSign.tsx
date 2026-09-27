import { Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import type { ReactElement } from "react";

import type { NavItem, OfferedSection } from "./nav-items";
import { useDisclosure } from "./use-disclosure";

/** Brass plate carrying a count, e.g. open issues. */
export function NavCount({ count }: { count: number }): ReactElement {
  return (
    <span className="inline-flex min-w-5 items-center justify-center rounded-control bg-trust-register px-1.5 text-chip text-register">
      {count}
    </span>
  );
}

/** What a list of destinations adds up to on its plates; 0 shows none. */
export function countOf(items: readonly NavItem[]): number {
  return items.reduce((sum, item) => sum + (item.count ?? 0), 0);
}

/*
 * A sign in the band, at the band's full height, in its lettering.
 *
 * The ring sits inside the sign rather than around it: around it, its top edge
 * would be off the top of the screen and its bottom edge on the room, where
 * brass on limewash is too faint to find. It is the on-board brass, because the
 * room's measures under 3:1 on the board in the light theme (DESIGN.md, the
 * On-Board Variant Rule). The padding keeps the ring off the lettering.
 */
const SIGN =
  "flex h-full items-center gap-1.5 border-b-[3px] px-2 text-label whitespace-nowrap uppercase transition-colors duration-150 ease-out focus-visible:-outline-offset-4 focus-visible:outline-trust-register";
const SIGN_AT_REST =
  "border-transparent text-register-ink-muted hover:text-register-ink";
const SIGN_OPEN = "border-transparent text-register-ink";
/* The band's active marker: full ink and a 3px brass underline. */
const SIGN_CURRENT = "border-trust-register text-register-ink";

/*
 * The panel is a piece of the board hanging from the band: the band's ground,
 * no top edge where it meets it, the panel radius on the lower corners only,
 * and the one shadow.
 */
const PANEL =
  "absolute top-full z-10 min-w-56 divide-y divide-register-line rounded-b-panel border border-t-0 border-register-line bg-register py-1 shadow-raised";
const PANEL_FROM_START = `${PANEL} left-0`;
const PANEL_FROM_END = `${PANEL} right-0`;

/*
 * A row is one of the board's name rows. The current one carries the band's
 * brass marker turned to the side a vertical list faces: an edge on its
 * leading side, so it is a shape as well as a colour. The edge is 3px of the
 * row's 16px padding, so the names start where they would without it.
 */
const ROW =
  "flex min-h-11 items-center justify-between gap-3 border-s-[3px] ps-3.25 pe-4 text-body font-medium whitespace-nowrap transition-colors duration-150 ease-out hover:bg-register-raised focus-visible:-outline-offset-4 focus-visible:outline-trust-register";
const ROW_AT_REST = `${ROW} border-transparent text-register-ink`;
const ROW_CURRENT = `${ROW} border-trust-register text-trust-register`;

const CHEVRON = "size-3 shrink-0 transition-transform duration-150 ease-out";
const CHEVRON_OPEN = `${CHEVRON} rotate-180`;

/** Whether a destination is the one the reader is on. */
function isCurrent(item: NavItem, current: NavItem | undefined): boolean {
  return current !== undefined && item.to === current.to;
}

/**
 * The chevron that tells a sign that opens something from one that goes
 * somewhere; a resident's band carries both. Drawn inline so it takes the
 * sign's own colour, and hidden from assistive technology, which hears
 * aria-expanded instead.
 */
function Chevron({ open }: { open: boolean }): ReactElement {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 12 12"
      className={open ? CHEVRON_OPEN : CHEVRON}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
    >
      <path d="M2.5 4.5 6 8l3.5-3.5" />
    </svg>
  );
}

/** One destination in a list of rows: a band panel's, or the phone sheet's. */
export function DestinationRow({
  item,
  current,
  onPress,
  classes = { atRest: ROW_AT_REST, current: ROW_CURRENT },
}: {
  item: NavItem;
  current: NavItem | undefined;
  onPress: () => void;
  /** Overrides the band panel's row classes, as the sheet does. */
  classes?: { atRest: string; current: string };
}): ReactElement {
  const { t } = useTranslation();
  const here = isCurrent(item, current);

  return (
    <li>
      <Link
        to={item.to}
        // The router marks the page itself; the row's marker also covers the
        // pages under it, and comes from the current destination.
        activeOptions={{ exact: true }}
        onClick={onPress}
        className={here ? classes.current : classes.atRest}
      >
        {t(item.labelKey)}
        {item.count === undefined ? null : <NavCount count={item.count} />}
      </Link>
    </li>
  );
}

/**
 * One section's sign in the band.
 *
 * A section this account is offered one destination in is that destination's
 * own sign, a plain link under its own name: a one-row panel costs a press and
 * hides nothing. Any other section is a button that opens its destinations
 * under it, in a panel that is part of the board.
 *
 * The sign whose section holds the current page carries the band's active
 * marker and aria-current, so a screen reader hears which section it is in as
 * a sighted reader sees it.
 */
export function SectionSign({
  section,
  current,
  atEnd,
}: {
  section: OfferedSection;
  current: NavItem | undefined;
  /** The sign at the band's right end, whose panel opens leftwards. */
  atEnd: boolean;
}): ReactElement {
  const { t } = useTranslation();
  const { open, toggle, close, panelId, triggerRef, containerRef } =
    useDisclosure<HTMLLIElement>();
  const here = section.items.some((item) => isCurrent(item, current));
  const place = atEnd ? "relative ml-auto flex" : "relative flex";
  const [only] = section.items;

  if (section.items.length === 1 && only !== undefined) {
    return (
      <li className={place}>
        <Link
          to={only.to}
          activeOptions={{ exact: true }}
          className={`${SIGN} ${here ? SIGN_CURRENT : SIGN_AT_REST}`}
        >
          {t(only.labelKey)}
          {only.count === undefined ? null : <NavCount count={only.count} />}
        </Link>
      </li>
    );
  }

  const count = countOf(section.items);
  const state = here ? SIGN_CURRENT : open ? SIGN_OPEN : SIGN_AT_REST;

  return (
    <li ref={containerRef} className={place}>
      <button
        ref={triggerRef}
        type="button"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        aria-current={here ? "true" : undefined}
        onClick={toggle}
        className={`${SIGN} ${state}`}
      >
        {t(section.labelKey)}
        {count > 0 ? <NavCount count={count} /> : null}
        <Chevron open={open} />
      </button>
      {open ? (
        <ul id={panelId} className={atEnd ? PANEL_FROM_END : PANEL_FROM_START}>
          {section.items.map((item) => (
            <DestinationRow
              key={item.to}
              item={item}
              current={current}
              onPress={close}
            />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

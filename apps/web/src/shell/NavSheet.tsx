import { useTranslation } from "react-i18next";
import { useEffect, type ReactElement } from "react";

import type { NavItem, OfferedSection } from "./nav-items";
import { DestinationRow } from "./SectionSign";

/** Where the band takes over from the bar: Tailwind's lg, 1024px. */
const WIDE = "(min-width: 64rem)";

/*
 * The sheet rises from the bar's top edge, inside the bar's own positioning,
 * and is never taller than the window less the band and the bar (64px + 56px),
 * scrolling inside itself rather than the page behind it.
 */
const SHEET =
  "absolute inset-x-0 bottom-full max-h-[calc(100dvh-7.5rem)] overflow-y-auto overscroll-contain rounded-t-panel border-t border-register-line bg-register shadow-raised";

/* The register's floor row: the raised board ground, muted label lettering. */
const FLOOR =
  "bg-register-raised px-6 py-1.5 text-label text-register-ink-muted uppercase";

/*
 * A name row. The leading edge is 3px of the 24px, so the name lines up with
 * the floor row's label above it.
 */
const ROW =
  "flex min-h-11 items-center justify-between gap-3 border-s-[3px] ps-5.25 pe-6 text-body font-medium transition-colors duration-150 ease-out hover:bg-register-raised focus-visible:-outline-offset-4 focus-visible:outline-trust-register";
const ROWS = {
  atRest: `${ROW} border-transparent text-register-ink`,
  current: `${ROW} border-trust-register text-trust-register`,
};

/**
 * Every section of the navigation on a phone, behind the bar's menu button.
 *
 * Read like the name board in a stairwell, floor by floor: each section a floor
 * row, its destinations as the names under it. Every offered destination is
 * here, the bar's three included, because the sheet is the whole map and the
 * bar only a shortcut into it.
 *
 * AppShell owns whether it is open, since the room it covers and the bar it
 * rises from are both AppShell's. The sheet adds the one way of closing that
 * only it has: the window widening to where the band shows, which would
 * otherwise hide the bar and leave the room behind it inert.
 */
export function NavSheet({
  id,
  sections,
  current,
  onClose,
}: {
  id: string;
  sections: readonly OfferedSection[];
  current: NavItem | undefined;
  onClose: () => void;
}): ReactElement {
  const { t } = useTranslation();

  useEffect(() => {
    const wide = globalThis.matchMedia?.(WIDE);
    if (wide === undefined) {
      return;
    }
    if (wide.matches) {
      onClose();
      return;
    }
    const onChange = (event: MediaQueryListEvent): void => {
      if (event.matches) {
        onClose();
      }
    };
    wide.addEventListener("change", onChange);
    return () => {
      wide.removeEventListener("change", onChange);
    };
  }, [onClose]);

  return (
    <div id={id} className={SHEET}>
      {sections.map((section) => (
        <div key={section.id}>
          <h2 className={FLOOR}>{t(section.labelKey)}</h2>
          <ul className="divide-y divide-register-line">
            {section.items.map((item) => (
              <DestinationRow
                key={item.to}
                item={item}
                current={current}
                onPress={onClose}
                classes={ROWS}
              />
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

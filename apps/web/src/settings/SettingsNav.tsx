import { Link } from "@tanstack/react-router";
import { useEffect, useId, useRef, type ReactElement } from "react";
import { useTranslation } from "react-i18next";

import { BoardMark } from "../ui/BoardZone";
import type { SETTINGS_SECTIONS, SettingsSectionId } from "./settings-sections";

/*
 * One entry. Below 1024px the list is a row above the content and the current
 * entry is underlined; from 1024px it is a column beside the content and the
 * marker turns to the side the column faces, a leading edge, as the band's
 * rows do (DESIGN.md, Navigation). Either way it is a shape as well as a
 * colour, and brass marks nothing else here. min-h-11 is the 44px touch
 * target.
 */
const ENTRY =
  "flex min-h-11 items-center border-b-[3px] px-3 text-body font-medium whitespace-nowrap transition-colors duration-150 ease-out lg:border-b-0 lg:border-s-[3px] lg:whitespace-normal";
const ENTRY_AT_REST = `${ENTRY} border-transparent text-ink-muted hover:text-ink`;
const ENTRY_CURRENT = `${ENTRY} border-trust text-ink`;

type Section = (typeof SETTINGS_SECTIONS)[number];

export interface SettingsNavProps {
  sections: readonly (typeof SETTINGS_SECTIONS)[number][];
  current: SettingsSectionId;
}

/**
 * The settings screen's own navigation, between its sections.
 *
 * Links rather than tabs: each section is a route, so the back button walks
 * the sections the reader went through and any one of them can be linked to.
 * The row scrolls sideways on a narrow screen rather than wrapping, so the
 * content below it starts at the same height whichever section is open.
 *
 * The viewer's own account comes first and bare. The association's sections
 * follow under a heading that carries the board's sign, so a board member can
 * tell their own settings from the association's before opening either. A
 * viewer with no association section is shown neither the heading nor the sign.
 */
export function SettingsNav({
  sections,
  current,
}: SettingsNavProps): ReactElement {
  const { t } = useTranslation();
  const listRef = useRef<HTMLDivElement>(null);
  const signId = useId();
  const headingId = useId();

  /*
   * A section reached by its address may be past the right edge of the row on
   * a phone, where nothing would say which one is open. Scrolled sideways into
   * view rather than with scrollIntoView, which would move the page as well.
   * The column from 1024px never overflows, so there this changes nothing.
   */
  useEffect(() => {
    const list = listRef.current;
    const here = list?.querySelector<HTMLElement>('[aria-current="page"]');
    if (list == null || here == null) {
      return;
    }
    const start = here.offsetLeft;
    const end = start + here.offsetWidth;
    if (start < list.scrollLeft) {
      list.scrollLeft = start;
    } else if (end > list.scrollLeft + list.clientWidth) {
      list.scrollLeft = end - list.clientWidth;
    }
  }, [current]);

  const personal = sections.filter((section) => section.group === "personal");
  const association = sections.filter(
    (section) => section.group === "association",
  );

  const entries = (list: readonly Section[]): ReactElement => (
    <ul className="flex lg:flex-col">
      {list.map((section) => (
        <li key={section.id} className="shrink-0">
          <Link
            to="/settings/$section"
            params={{ section: section.id }}
            aria-current={section.id === current ? "page" : undefined}
            className={section.id === current ? ENTRY_CURRENT : ENTRY_AT_REST}
          >
            {t(section.labelKey)}
          </Link>
        </li>
      ))}
    </ul>
  );

  return (
    <nav aria-label={t("settings.sections.label")} className="min-w-0">
      <div
        ref={listRef}
        className="relative flex overflow-x-auto border-b border-line lg:flex-col lg:overflow-visible lg:border-b-0"
      >
        {entries(personal)}

        {association.length > 0 ? (
          <div
            role="group"
            aria-labelledby={`${signId} ${headingId}`}
            className="flex shrink-0 items-center border-s border-line ps-3 lg:mt-4 lg:flex-col lg:items-stretch lg:border-s-0 lg:ps-0"
          >
            <div className="flex shrink-0 items-center gap-2 px-3 lg:flex-col lg:items-start lg:gap-1 lg:py-2 lg:ps-[calc(0.75rem+3px)]">
              <BoardMark id={signId} />
              <span
                id={headingId}
                className="text-small font-medium whitespace-nowrap text-ink-muted lg:whitespace-normal"
              >
                {t("settings.sections.associationGroup")}
              </span>
            </div>
            {entries(association)}
          </div>
        ) : null}
      </div>
    </nav>
  );
}

import { Link, useLocation } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import type { ReactElement, ReactNode } from "react";

import { currentDestination, sectionsOf, type NavItem } from "./nav-items";
import { NavSheet } from "./NavSheet";
import { countOf, NavCount, SectionSign } from "./SectionSign";
import { useDisclosure } from "./use-disclosure";

export interface AppShellProps {
  housingCooperativeName: string;
  /**
   * The housing cooperative's mark, as two paths on this instance's own origin.
   *
   * `dark` is the variant made for the band. When it is absent the mark is
   * shown on a light plate instead, because a mark drawn in dark ink would
   * otherwise disappear into a dark band; see BandLogo.
   */
  logo?: { light: string | null; dark: string | null };
  /** Signed-in person's display name, or undefined while unknown. */
  personName?: string;
  /** Their most senior role, already translated by the caller. */
  roleLabel?: string;
  navItems: readonly NavItem[];
  onSignOut?: () => void;
  children: ReactNode;
}

/**
 * The housing cooperative's mark in the band.
 *
 * The band is dark, and a logo is somebody else's artwork: most are drawn in
 * dark ink on white and vanish on it. This is handled rather than hoped about.
 * A variant made for dark surfaces is used as it is; without one, the mark is
 * placed on a light plate, which is legible whichever way the artwork was
 * drawn. The settings screen shows the same two cases, so the board sees which
 * of them applies to them.
 *
 * The mark is bounded in both directions, not only in height. Its proportions
 * are the association's own and can be anything: a mark twenty times as wide as
 * it is tall is a valid image, and constrained by height alone it would fill the
 * band, while shrink-0 - which is there so the mark does not collapse - stops it
 * yielding the room back to the cooperative's name and the navigation. Bounded
 * both ways it is contained instead, whatever artwork a board uploads.
 *
 * The alt text is empty on purpose: the cooperative's name sits beside this in
 * text, and a screen reader announcing it twice serves nobody.
 */
function BandLogo({
  light,
  dark,
}: {
  light: string | null;
  dark: string | null;
}): ReactElement | null {
  if (dark !== null) {
    return (
      <img
        src={dark}
        alt=""
        className="max-h-9 w-auto max-w-36 shrink-0 object-contain"
      />
    );
  }
  if (light === null) {
    return null;
  }
  return (
    <span className="inline-flex shrink-0 items-center rounded-control bg-raised px-2 py-1">
      <img
        src={light}
        alt=""
        className="max-h-7 w-auto max-w-32 object-contain"
      />
    </span>
  );
}

/*
 * The bar carries the same 3px brass marker as the band, on the top edge
 * (the side facing the content) since the bar sits at the bottom of the
 * screen. Colour alone would not do: DESIGN.md requires a second signal, and
 * a brass-on-dark colour shift is invisible to a red-green colour blind
 * board member.
 *
 * Lettered at the sign chip's size rather than the band's: four columns on a
 * 360px phone are 90px each, and at the band's size "Bokningar" and
 * "Adressbok" already fill one. A longer label wraps inside its column.
 */
const BAR_ITEM =
  "flex min-h-14 w-full items-center justify-center gap-1.5 border-t-[3px] px-1 text-center text-chip uppercase transition-colors duration-150 ease-out focus-visible:-outline-offset-4 focus-visible:outline-trust-register";
const BAR_ITEM_AT_REST = `${BAR_ITEM} border-transparent text-register-ink-muted hover:text-register-ink`;
const BAR_ITEM_OPEN = `${BAR_ITEM} border-transparent text-register-ink`;
const BAR_ITEM_CURRENT = `${BAR_ITEM} border-trust-register text-trust-register`;

/* Written out, so the stylesheet carries each column's placement. */
const COLUMN = { 1: "col-start-1", 2: "col-start-2", 3: "col-start-3" };

/**
 * The application frame.
 *
 * Follows the design system's board topology: a fixed dark band carries the
 * cooperative's identity and the navigation as a row of section signs, and the
 * content lives in the light room below. The regions are fixed and swap their
 * content rather than moving, so a board member always finds the same thing in
 * the same place.
 *
 * The navigation appears twice in the markup, once in the band from 1024px and
 * once as a bottom bar below that, because the two sit in different parents and
 * CSS cannot move an element between them. Only ever one is exposed: the other
 * is `display: none` at that width, which removes it from the accessibility
 * tree as well as from view. They share one aria-label because they are the
 * same navigation, and both are built from the same items, so a destination
 * cannot appear in one and be forgotten in the other: the band holds every
 * offered destination behind its section signs, and the bar's menu button
 * opens a sheet holding every one of them again.
 *
 * The bar is where a thumb reaches, and residents are mostly on phones. It
 * keeps three destinations chosen for the account and the menu button in the
 * fourth column, and while the sheet is open the room behind it is inert, so
 * neither a pointer nor a screen reader lands on what it covers; the header
 * and the bar stay live.
 */
export function AppShell({
  housingCooperativeName,
  logo,
  personName,
  roleLabel,
  navItems,
  onSignOut,
  children,
}: AppShellProps): ReactElement {
  const { t } = useTranslation();
  // The path inside the application; the router strips its /app basepath.
  const pathname = useLocation({ select: (location) => location.pathname });
  const current = currentDestination(pathname, navItems);
  const sections = sectionsOf(navItems);
  const {
    open: sheetOpen,
    toggle: toggleSheet,
    close: closeSheet,
    panelId: sheetId,
    triggerRef: sheetTriggerRef,
    containerRef: sheetColumnRef,
  } = useDisclosure<HTMLLIElement>();
  // In column order, which is also the order Tab walks them in.
  const bar = navItems
    .flatMap((item) =>
      item.barSlot === undefined ? [] : [{ item, slot: item.barSlot }],
    )
    .toSorted((a, b) => a.slot - b.slot);
  const behindTheMenu = navItems.filter((item) => item.barSlot === undefined);
  // The menu is where you are when the page is none of the bar's three: a
  // phone would otherwise not say at all which part of the product this is.
  const sheetHoldsCurrent =
    current !== undefined && current.barSlot === undefined;
  const sheetCount = countOf(behindTheMenu);

  return (
    <div className="flex min-h-screen flex-col bg-page">
      {/*
       * The frame is screen furniture. A printed register extract carries the
       * cooperative's own heading and its register stamp, and the navigation
       * band on top of it would only take a third of the first page.
       */}
      <header className="flex h-16 shrink-0 items-center gap-8 bg-register px-4 text-register-ink sm:px-8 print:hidden">
        <div className="flex min-w-0 items-center gap-3">
          {logo === undefined ? null : (
            <BandLogo light={logo.light} dark={logo.dark} />
          )}
          <div className="flex min-w-0 flex-col">
            <span className="truncate text-label uppercase">
              {housingCooperativeName}
            </span>
            <span className="text-chip text-register-ink-muted uppercase">
              {t("welcome.title")}
            </span>
          </div>
        </div>

        <nav
          aria-label={t("nav.primary")}
          className="hidden h-16 grow items-stretch lg:flex"
        >
          <ul className="flex grow items-stretch gap-2">
            {sections.map((section) => (
              <SectionSign
                key={section.id}
                section={section}
                current={current}
                atEnd={section.id === "settings"}
              />
            ))}
          </ul>
        </nav>

        <div className="ml-auto flex min-w-0 items-center gap-3">
          {/*
           * Beside the sign-out button on a phone from 640px, out of the way
           * while the band's signs need the room, and back from 1280px.
           */}
          {personName === undefined ? null : (
            <div className="hidden min-w-0 flex-col items-end sm:flex lg:hidden xl:flex">
              <span className="max-w-48 truncate text-small font-semibold">
                {personName}
              </span>
              {roleLabel === undefined ? null : (
                <span className="text-chip text-trust-register uppercase">
                  {roleLabel}
                </span>
              )}
            </div>
          )}
          {onSignOut === undefined ? null : (
            <button
              type="button"
              onClick={onSignOut}
              className="min-h-11 shrink-0 rounded-control border border-register-line px-3 text-small font-semibold whitespace-nowrap text-register-ink-muted transition-colors duration-150 ease-out hover:text-register-ink focus-visible:outline-trust-register"
            >
              {t("nav.signOut")}
            </button>
          )}
        </div>
      </header>

      <main inert={sheetOpen} className="grow px-4 py-5 sm:px-10 print:p-0">
        {children}
      </main>

      <nav
        aria-label={t("nav.primary")}
        className="sticky bottom-0 z-10 shrink-0 border-t border-register-line bg-register lg:hidden print:hidden"
      >
        {/*
         * Four fixed columns: the account's three in theirs and the menu
         * button always in the fourth, so it never moves, and a column the
         * account has nothing for stays empty rather than letting the others
         * stretch into it.
         */}
        <ul className="grid grid-cols-4">
          {bar.map(({ item, slot }) => (
            <li key={item.to} className={COLUMN[slot]}>
              <Link
                to={item.to}
                activeOptions={{ exact: true }}
                className={
                  item.to === current?.to ? BAR_ITEM_CURRENT : BAR_ITEM_AT_REST
                }
              >
                {t(item.labelKey)}
                {item.count === undefined ? null : (
                  <NavCount count={item.count} />
                )}
              </Link>
            </li>
          ))}
          <li ref={sheetColumnRef} className="col-start-4">
            <button
              ref={sheetTriggerRef}
              type="button"
              aria-expanded={sheetOpen}
              aria-controls={sheetOpen ? sheetId : undefined}
              aria-current={sheetHoldsCurrent ? "true" : undefined}
              onClick={toggleSheet}
              className={
                sheetHoldsCurrent
                  ? BAR_ITEM_CURRENT
                  : sheetOpen
                    ? BAR_ITEM_OPEN
                    : BAR_ITEM_AT_REST
              }
            >
              {t("nav.menu")}
              {sheetCount > 0 ? <NavCount count={sheetCount} /> : null}
            </button>
            {sheetOpen ? (
              <NavSheet
                id={sheetId}
                sections={sections}
                current={current}
                onClose={closeSheet}
              />
            ) : null}
          </li>
        </ul>
      </nav>
    </div>
  );
}

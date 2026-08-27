import { Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import type { ReactElement, ReactNode } from "react";

import type { TranslationKey } from "../i18n/translation-key";

export type { TranslationKey };

export interface NavItem {
  to: string;
  labelKey: TranslationKey;
  /** Shown as a small brass plate, e.g. an open issue count. */
  count?: number;
}

export interface AppShellProps {
  housingCooperativeName: string;
  /** Signed-in person's display name, or undefined while unknown. */
  personName?: string;
  /** Their most senior role, already translated by the caller. */
  roleLabel?: string;
  navItems: readonly NavItem[];
  onSignOut?: () => void;
  children: ReactNode;
}

/** Brass plate carrying a count, e.g. open issues. */
function NavCount({ count }: { count: number }): ReactElement {
  return (
    <span className="inline-flex min-w-5 items-center justify-center rounded-control bg-trust-register px-1.5 text-chip text-register">
      {count}
    </span>
  );
}

/**
 * The navigation links.
 *
 * Rendered by both the band and the bottom bar rather than duplicated, so a new
 * destination cannot appear in one and be forgotten in the other.
 */
function NavLinks({
  navItems,
  className,
  activeClassName,
}: {
  navItems: readonly NavItem[];
  className: string;
  activeClassName: string;
}): ReactElement {
  const { t } = useTranslation();

  return (
    <>
      {navItems.map((item) => (
        <Link
          key={item.to}
          to={item.to}
          className={className}
          activeProps={{ className: `${className} ${activeClassName}` }}
        >
          {t(item.labelKey)}
          {item.count === undefined ? null : <NavCount count={item.count} />}
        </Link>
      ))}
    </>
  );
}

const BAND_LINK =
  "flex items-center gap-2 border-b-[3px] border-transparent text-label uppercase text-register-ink-muted transition-colors duration-150 ease-out";
const BAND_LINK_ACTIVE = "border-trust-register text-register-ink";

/*
 * The bar carries the same 3px brass marker as the band, on the top edge
 * (the side facing the content) since the bar sits at the bottom of the
 * screen. Colour alone would not do: DESIGN.md requires a second signal, and
 * a brass-on-dark colour shift is invisible to a red-green colour blind
 * board member. Link already emits aria-current="page", so this closes the
 * visual half of the same gap.
 */
const BAR_LINK =
  "flex min-h-14 grow items-center justify-center gap-1.5 border-t-[3px] border-transparent text-label uppercase text-register-ink-muted";
const BAR_LINK_ACTIVE = "border-trust-register text-trust-register";

/**
 * The application frame.
 *
 * Follows the design system's board topology: a fixed dark band carries the
 * cooperative's identity and the navigation as a row of signs, and the content
 * lives in the light room below. The regions are fixed and swap their content
 * rather than moving, so a board member always finds the same thing in the same
 * place.
 *
 * The navigation appears twice in the markup, once in the band and once as a
 * bottom bar, because the two sit in different parents and CSS cannot move an
 * element between them. Only ever one is exposed: the other is `display: none`
 * at that breakpoint, which removes it from the accessibility tree as well as
 * from view. They share one aria-label because they are the same navigation.
 *
 * The bar is where a thumb reaches, and residents are mostly on phones.
 */
export function AppShell({
  housingCooperativeName,
  personName,
  roleLabel,
  navItems,
  onSignOut,
  children,
}: AppShellProps): ReactElement {
  const { t } = useTranslation();

  return (
    <div className="flex min-h-screen flex-col bg-page">
      <header className="flex h-16 shrink-0 items-center gap-8 bg-register px-4 text-register-ink sm:px-8">
        <div className="flex min-w-0 flex-col">
          <span className="truncate text-label uppercase">
            {housingCooperativeName}
          </span>
          <span className="text-chip text-register-ink-muted uppercase">
            {t("welcome.title")}
          </span>
        </div>

        <nav
          aria-label={t("nav.primary")}
          className="hidden h-16 grow items-stretch gap-6 sm:flex"
        >
          <NavLinks
            navItems={navItems}
            className={BAND_LINK}
            activeClassName={BAND_LINK_ACTIVE}
          />
        </nav>

        <div className="ml-auto flex items-center gap-3">
          {personName === undefined ? null : (
            <div className="hidden flex-col items-end sm:flex">
              <span className="text-small font-semibold">{personName}</span>
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
              className="min-h-11 rounded-control border border-register-line px-3 text-small font-semibold text-register-ink-muted transition-colors duration-150 ease-out hover:text-register-ink"
            >
              {t("nav.signOut")}
            </button>
          )}
        </div>
      </header>

      <main className="grow px-4 py-5 sm:px-10">{children}</main>

      <nav
        aria-label={t("nav.primary")}
        className="sticky bottom-0 flex shrink-0 border-t border-register-line bg-register sm:hidden"
      >
        <NavLinks
          navItems={navItems}
          className={BAR_LINK}
          activeClassName={BAR_LINK_ACTIVE}
        />
      </nav>
    </div>
  );
}

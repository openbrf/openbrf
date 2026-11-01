import { useTranslation } from "react-i18next";
import type { ReactElement } from "react";

import type { NavItem } from "./nav-items";
import {
  Chevron,
  DestinationRow,
  PANEL_FROM_END,
  ROW_AT_REST,
} from "./SectionSign";
import { useDisclosure } from "./use-disclosure";

/** The person's own settings: their profile and how they sign in. */
export const ACCOUNT_SETTINGS = "/settings";

const SETTINGS_ROW: NavItem = {
  to: ACCOUNT_SETTINGS,
  labelKey: "nav.settings",
  section: "settings",
};

/*
 * The trigger stands at the band's full height, like a section sign, so the
 * panel hangs from the band's lower edge and the trigger carries the sign's
 * 3px brass underline on the person's own page. The name keeps its own case:
 * it is somebody's name, not a sign.
 */
const TRIGGER =
  "flex h-full max-w-full items-center gap-2 border-b-[3px] px-2 text-start transition-colors duration-150 ease-out focus-visible:-outline-offset-4 focus-visible:outline-trust-register";
const TRIGGER_AT_REST = `${TRIGGER} border-transparent text-register-ink-muted hover:text-register-ink`;
const TRIGGER_OPEN = `${TRIGGER} border-transparent text-register-ink`;
const TRIGGER_CURRENT = `${TRIGGER} border-trust-register text-register-ink`;

/*
 * The name truncates rather than leaving the band: narrow on a phone, where it
 * shares the band with the cooperative's name, narrower again between 1024px
 * and 1280px, where the section signs need the room.
 */
const WIDTH = "max-w-28 sm:max-w-48 lg:max-w-32 xl:max-w-48";
const NAME = `block ${WIDTH} truncate text-small font-semibold`;
/*
 * The support role is read as well as the name, so it wraps inside the same
 * width instead of widening the trigger past it and into the cooperative's
 * identity on a phone.
 */
const ROLE = `${WIDTH} text-end text-chip text-trust-register uppercase`;

/* A row that does something rather than going somewhere: a panel row. */
const ACTION_ROW = `${ROW_AT_REST} w-full text-start disabled:opacity-60`;

/**
 * The signed-in person's own things, under their name at the band's end.
 *
 * Three of them, in this order: their settings, the resident preview where it
 * is offered (ADR 0049) and signing out. They are the person's rather than the
 * association's, so they stand apart from the navigation, and the band names
 * whose they are. The board's settings for the association stay in the board's
 * section.
 *
 * The band is there at every width, so this is the one place the three are
 * found, on a phone as on a laptop.
 *
 * The disclosure pattern, as the section signs use it, and not a menu widget:
 * the panel holds a link and two buttons, read in browse mode and walked with
 * Tab in document order, and nothing opens on hover. Choosing any of the three
 * closes it.
 *
 * During a support session (ADR 0028) the name is the supporter's and the role
 * under it says what they hold; signing out ends the support session, which is
 * AppShell's to decide.
 */
export function AccountDisclosure({
  name,
  role,
  pathname,
  onStartPreview,
  onSignOut,
  signingOut,
}: {
  /** The person's name, or undefined while it is not known. */
  name: string | undefined;
  /** What the name holds, said under it; only during a support session. */
  role: string | undefined;
  /** The page the reader is on, inside the application. */
  pathname: string;
  /** Starts the resident preview; absent when it is not offered. */
  onStartPreview?: () => void;
  /** Signs out; absent when the caller does not handle it. */
  onSignOut?: () => void;
  /** Whether a sign-out the caller tracks is waiting for its answer. */
  signingOut: boolean;
}): ReactElement {
  const { t } = useTranslation();
  const { open, toggle, close, panelId, triggerRef, containerRef } =
    useDisclosure<HTMLDivElement>();
  // A name of nothing but spaces names nobody.
  const shownName =
    name === undefined || name.trim() === "" ? t("nav.account") : name;
  const here =
    pathname === ACCOUNT_SETTINGS ||
    pathname.startsWith(`${ACCOUNT_SETTINGS}/`);
  const state = here ? TRIGGER_CURRENT : open ? TRIGGER_OPEN : TRIGGER_AT_REST;

  return (
    <div
      ref={containerRef}
      className="relative ml-auto flex min-w-0 shrink-0 self-stretch"
    >
      <button
        ref={triggerRef}
        type="button"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        aria-current={here ? "true" : undefined}
        onClick={toggle}
        className={state}
      >
        <span className="flex min-w-0 flex-col items-end">
          <span className={NAME}>{shownName}</span>
          {role === undefined ? null : (
            <>
              {/*
               * A space the flex layout does not render, so the trigger's
               * accessible name keeps the name and the role apart.
               */}{" "}
              <span className={ROLE}>{role}</span>
            </>
          )}
        </span>
        <Chevron open={open} />
      </button>
      {open ? (
        <ul id={panelId} className={PANEL_FROM_END}>
          <DestinationRow
            item={SETTINGS_ROW}
            current={here ? SETTINGS_ROW : undefined}
            onPress={close}
          />
          {onStartPreview === undefined ? null : (
            <li>
              <button
                type="button"
                onClick={() => {
                  close();
                  onStartPreview();
                }}
                className={ACTION_ROW}
              >
                {t("preview.start")}
              </button>
            </li>
          )}
          {onSignOut === undefined ? null : (
            <li>
              <button
                type="button"
                onClick={() => {
                  close();
                  onSignOut();
                }}
                // Once at a time: a second press while the first is unanswered
                // would only race it.
                disabled={signingOut}
                className={ACTION_ROW}
              >
                {t("nav.signOut")}
              </button>
            </li>
          )}
        </ul>
      ) : null}
    </div>
  );
}

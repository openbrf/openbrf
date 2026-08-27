import { useTranslation } from "react-i18next";
import type { ReactElement } from "react";

import type { TranslationKey } from "../i18n/translation-key";
import type { RegisterSign } from "./register-api";

/**
 * A sign on the board (skylt-chip in DESIGN.md): a role or a state.
 *
 * Every sign carries text. Colour is never the only signal - brass for a
 * position of trust, warn plus a lock for a protected person, a dashed outline
 * for a residency that has ended - and each of those is paired with a written
 * label, so a board member who cannot tell the hues apart reads the same
 * register as everyone else.
 */

const SIGN_LABEL: Record<RegisterSign, TranslationKey> = {
  CHAIR: "register.sign.chair",
  BOARD_MEMBER: "register.sign.boardMember",
  DEPUTY_BOARD_MEMBER: "register.sign.deputyBoardMember",
  MEMBER: "register.sign.member",
  RESIDENT: "register.sign.resident",
  PROTECTED: "register.sign.protected",
  MOVED_OUT: "register.sign.movedOut",
};

/**
 * Signs of trust wear the brass. DESIGN.md reserves it for exactly that, so
 * this set is the whole of its use on the board.
 */
const TRUST_SIGNS = new Set<RegisterSign>([
  "CHAIR",
  "BOARD_MEMBER",
  "DEPUTY_BOARD_MEMBER",
]);

/*
 * Outlined on the board, per DESIGN.md: the room-side soft fills would sit
 * wrong on the dark panel. Every colour here is an on-board variant, because
 * the room-side value would not hold AA against --obrf-surface-register.
 */
const BASE =
  "inline-flex h-5.5 shrink-0 items-center gap-1 rounded-control border px-2 text-chip uppercase";
const NEUTRAL = "border-register-line text-register-ink-muted";
const TRUST = "border-trust-register text-trust-register";
const PROTECTED = "border-warn-register text-warn-register";
/** Dashed marks the moved-out state, which is the shape half of that signal. */
const MOVED_OUT = "border-dashed border-register-line text-register-ink-muted";

function classFor(sign: RegisterSign): string {
  if (TRUST_SIGNS.has(sign)) {
    return `${BASE} ${TRUST}`;
  }
  if (sign === "PROTECTED") {
    return `${BASE} ${PROTECTED}`;
  }
  if (sign === "MOVED_OUT") {
    return `${BASE} ${MOVED_OUT}`;
  }
  return `${BASE} ${NEUTRAL}`;
}

/**
 * A closed padlock.
 *
 * Inline rather than a font or an image: it has to inherit the sign's colour,
 * and DESIGN.md forbids emoji. Hidden from assistive technology because the
 * sign's own text already says "Skyddad" - announcing both would say it twice.
 */
function LockIcon(): ReactElement {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 12 12"
      className="size-3"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.25"
    >
      <rect x="2.25" y="5.25" width="7.5" height="5.5" rx="1" />
      <path d="M4.25 5.25V3.75a1.75 1.75 0 0 1 3.5 0v1.5" />
    </svg>
  );
}

export function SignChip({ sign }: { sign: RegisterSign }): ReactElement {
  const { t } = useTranslation();

  return (
    <span className={classFor(sign)}>
      {sign === "PROTECTED" ? <LockIcon /> : null}
      {t(SIGN_LABEL[sign])}
    </span>
  );
}

/** The signs on one row, in the order the server fixed. */
export function SignRow({
  signs,
}: {
  signs: readonly RegisterSign[];
}): ReactElement {
  return (
    <span className="flex flex-wrap items-center gap-1.5">
      {signs.map((sign) => (
        <SignChip key={sign} sign={sign} />
      ))}
    </span>
  );
}

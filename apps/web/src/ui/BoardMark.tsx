import { useId } from "react";
import { useTranslation } from "react-i18next";
import type { ReactElement, ReactNode } from "react";

import type { TranslationKey } from "../i18n/translation-key";

/**
 * Who a function on a screen is for, when it is not everybody who lives here.
 *
 * Read off the capability that offers the function, never off a role: the
 * screen already decided to render it from `viewer.capabilities`, and this only
 * says out loud whose work it is. Three values, because three different groups
 * hold the capabilities the board's pages are offered on:
 *
 * - `board`: what only the elected board does - a queue to decide, a calendar
 *   to keep, the association's settings.
 * - `issueHandling`: the issue queue, which the board shares with the external
 *   property manager (förvaltare). Signed "Styrelsen" alone it would tell the
 *   property manager this is not theirs, which is the one thing it is.
 * - `administrator`: what only the instance's administrator holds, such as a
 *   system role, a theme or a plugin's licence. A board seat does not carry
 *   it, so the board sign would be wrong on it too.
 */
export type BoardAudience = "board" | "issueHandling" | "administrator";

interface AudienceText {
  sign: TranslationKey;
  note: TranslationKey;
}

const TEXT: Readonly<Record<BoardAudience, AudienceText>> = {
  board: { sign: "boardPage.board.sign", note: "boardPage.board.note" },
  issueHandling: {
    sign: "boardPage.issueHandling.sign",
    note: "boardPage.issueHandling.note",
  },
  administrator: {
    sign: "boardPage.administrator.sign",
    note: "boardPage.administrator.note",
  },
};

/** The one sentence saying who sees a function for this audience. */
export function audienceNote(audience: BoardAudience): TranslationKey {
  return TEXT[audience].note;
}

/*
 * Soft-filled, because these signs stand in the room (DESIGN.md, Skylt-chips).
 * Only the board's sign wears the brass: a board seat is a position of trust,
 * which is the one thing brass means. The property manager and the
 * administrator are neutral roles, and DESIGN.md lists Förvaltare among the
 * neutral signs by name. Letters in ink on every ground, so the sign holds AA
 * whatever soft colour a theme gives the trust accent.
 */
const SIGN_BASE =
  "inline-flex h-5.5 shrink-0 items-center rounded-control border px-2 text-chip text-ink uppercase";

const SIGN_TONE: Readonly<Record<BoardAudience, string>> = {
  board: "border-trust bg-trust-soft",
  issueHandling: "border-line-strong bg-raised",
  administrator: "border-line-strong bg-raised",
};

/**
 * The sign that says whose function this is: "Styrelsen" for the board.
 *
 * On the heading of every board page (`BoardPage`), and in its compact form on
 * a control that sits inside a resident's content - an edit button on a
 * document, a strike-through on a comment - which is the one kind of board
 * control a house page keeps (ADR 0049). One mark in both places, so a board
 * member learns it once and reads it everywhere.
 */
export function BoardMark({
  audience = "board",
  id,
}: {
  audience?: BoardAudience;
  /** For a control group that takes its name from the sign. */
  id?: string;
}): ReactElement {
  const { t } = useTranslation();

  return (
    <span id={id} className={`${SIGN_BASE} ${SIGN_TONE[audience]}`}>
      {t(TEXT[audience].sign)}
    </span>
  );
}

/**
 * Controls only the board is offered, set inside content everybody reads.
 *
 * A labelled group led by the sign, so a board member reading a resident's
 * screen can tell which buttons are theirs alone, and a screen reader announces
 * the group by whose it is before the first control in it.
 */
export function BoardControls({
  audience = "board",
  children,
}: {
  audience?: BoardAudience;
  children: ReactNode;
}): ReactElement {
  const signId = useId();

  return (
    <div
      role="group"
      aria-labelledby={signId}
      className="flex flex-wrap items-center gap-2"
    >
      <BoardMark audience={audience} id={signId} />
      {children}
    </div>
  );
}

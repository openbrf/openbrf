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
 * hold the capabilities a mixed screen puts beside a resident's own:
 *
 * - `board`: what only the elected board does - a queue to decide, a calendar
 *   to keep, the association's settings.
 * - `issueHandling`: the issue queue, which the board shares with the external
 *   property manager (förvaltare). Signed "Styrelsen" alone it would tell the
 *   property manager this is not theirs, which is the one thing it is.
 * - `administrator`: what only the instance's administrator grants, such as a
 *   system role. A board seat does not carry it, so the board sign would be
 *   wrong on it too.
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
 * The compact form of the marker, for a control that sits inside a resident's
 * content - an edit button on a document, a strike-through on a comment - where
 * a whole zone would tear the content apart. The zone below carries the same
 * sign in its header, so a board member learns one mark and reads it everywhere.
 */
export function BoardMark({
  audience = "board",
  id,
}: {
  audience?: BoardAudience;
  /** For a control group or a zone that takes its name from the sign. */
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

export interface BoardZoneProps {
  /** What the zone is for, in a few words: "Handle issues", not "Board". */
  title: string;
  /** Whose work it is. The board's unless the capability is shared. */
  audience?: BoardAudience;
  /**
   * Replaces the standard sentence saying who sees the zone, where the screen
   * has something more exact to say. Still about who, never about how.
   */
  description?: string;
  children: ReactNode;
}

/**
 * The part of a screen that is the board's work rather than a resident's.
 *
 * Every mixed screen has the same shape: what a resident does there first, and
 * then this zone with the functions only the board - or the board and the
 * property manager - is offered. One component, so the order, the sign and the
 * surface are the same on bookings as on documents, and a volunteer who learns
 * it once does not have to learn it again on the next screen.
 *
 * Rendered only by a screen that has something to put in it. A resident is
 * never shown the zone, its sign or an empty frame; the caller holds the zone
 * behind the same capability that offers what is inside it.
 *
 * A region named by its sign and its title, so a screen reader announces both
 * ("Board, Handle bookings") and lists it among the page's landmarks. A div with
 * the role rather than a section element: the panels inside are sections, and
 * a caller looking for "the section holding this heading" should find the panel
 * rather than the zone around it. The panels keep their own h2, the level they
 * have on every other screen and in the setup wizard; the zone's own h2 opens
 * the group, and the landmark is what says the panels belong to it.
 *
 * The sunken surface is the grouping: the board's panels stand on a different
 * ground from the resident's ones above them, which reads at a glance without
 * spending a colour that means something else.
 */
export function BoardZone({
  title,
  audience = "board",
  description,
  children,
}: BoardZoneProps): ReactElement {
  const { t } = useTranslation();
  const signId = useId();
  const titleId = useId();

  return (
    <div
      role="region"
      aria-labelledby={`${signId} ${titleId}`}
      className="flex flex-col gap-4 rounded-panel border border-line bg-sunken p-4 sm:p-5"
    >
      <header className="flex flex-col gap-1">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <BoardMark audience={audience} id={signId} />
          <h2 id={titleId} className="text-title">
            {title}
          </h2>
        </div>
        <p className="text-small text-ink-muted">
          {description ?? t(audienceNote(audience))}
        </p>
      </header>

      <div className="flex flex-col gap-5">{children}</div>
    </div>
  );
}

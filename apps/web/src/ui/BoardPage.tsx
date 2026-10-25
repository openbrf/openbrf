import type { ReactElement, ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { audienceNote, BoardMark, type BoardAudience } from "./BoardMark";
import { Notice } from "./Notice";

/**
 * The heading of one of the board's pages: the sign, then the page's title,
 * on one line and in one h1.
 *
 * Every board page carries it, in the same place, because the band's section
 * signs are not shown on a phone and the page has to say whose it is by
 * itself (ADR 0049). The sign is part of the heading's accessible name, so a
 * screen reader announces "Board, Handle bookings" as the zone's region used to
 * be announced, and a page is found by the same name whichever way it is read.
 *
 * For a screen that keeps its own header layout - a register with its actions
 * beside the title, say - in place of its plain h1.
 */
export function BoardPageTitle({
  audience = "board",
  children,
}: {
  audience?: BoardAudience;
  children: ReactNode;
}): ReactElement {
  return (
    <h1 className="flex flex-wrap items-center gap-x-3 gap-y-1 text-display">
      <BoardMark audience={audience} /> <span>{children}</span>
    </h1>
  );
}

/**
 * The sentence under a board page's heading saying who sees the page.
 *
 * For a screen that keeps its own header layout and introduction: it carries
 * this under its `BoardPageTitle`, before the introduction, so every board
 * page says whose it is in the same place (ADR 0049, decision 6). A page's
 * introduction says what the page is for; this says who it is for, and the two
 * are different sentences.
 */
export function BoardPageNote({
  audience = "board",
}: {
  audience?: BoardAudience;
}): ReactElement {
  const { t } = useTranslation();
  return (
    <p className="text-body text-ink-muted">{t(audienceNote(audience))}</p>
  );
}

/**
 * What one of the board's pages says to an account it is not offered to: one
 * sentence, and no sign. A sign over nothing would tell a resident the page was
 * the board's and then show them an empty room.
 *
 * For a route that decides from the viewer whether to mount a board screen at
 * all, so that a refused account is shown the same sentence on every board
 * page and the screen makes none of its requests.
 */
export function BoardPageRefused(): ReactElement {
  const { t } = useTranslation();
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-5">
      <Notice tone="info">{t("boardPage.notOffered")}</Notice>
    </div>
  );
}

export interface BoardPageProps {
  /** Named by the act, as the band names it: "Handle bookings". */
  title: string;
  /** Whose work it is. The board's unless the capability is shared. */
  audience?: BoardAudience;
  /**
   * Replaces the standard sentence saying who sees the page, where the page
   * has something more exact to say.
   */
  description?: string;
  /**
   * Whether this account holds what the page offers. False shows the one
   * sentence a refused page says, and no sign (`BoardPageRefused`).
   */
  offered: boolean;
  children: ReactNode;
}

/**
 * One of the board's pages, for a screen made to be one: its heading with the
 * sign, the sentence saying who sees it, and what the page holds.
 *
 * One page, one audience. A house page carries no board half any more; what the
 * board does on a module is a page of its own under /board, and this is its
 * frame, so the sign and the sentence are the same on every one of them.
 *
 * Whether to offer the page is the screen's question, read from the capability
 * that offers what is on it. The route asks for a session only, and the API
 * refuses the calls whatever this renders.
 */
export function BoardPage({
  title,
  audience = "board",
  description,
  offered,
  children,
}: BoardPageProps): ReactElement {
  if (!offered) {
    return <BoardPageRefused />;
  }

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-5">
      <header className="flex flex-col gap-1">
        <BoardPageTitle audience={audience}>{title}</BoardPageTitle>
        {description === undefined ? (
          <BoardPageNote audience={audience} />
        ) : (
          <p className="text-body text-ink-muted">{description}</p>
        )}
      </header>

      {children}
    </div>
  );
}

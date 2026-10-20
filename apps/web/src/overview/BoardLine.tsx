import { Link } from "@tanstack/react-router";
import { useCallback, useId, type ReactElement } from "react";
import { useTranslation } from "react-i18next";

import { audienceOf, waitingIn, type QueueId } from "../board/queues";
import { navItemsFor } from "../shell/nav-items";
import { useNavLabel } from "../shell/use-nav-label";
import { BoardMark } from "../ui/BoardZone";
import { QUIET_BUTTON } from "../ui/controls";
import { ITEM_LINK, ITEM_ROW } from "./ReadPanel";
import { useRead } from "./use-read";

/**
 * The board's one line on the overview: how much is waiting in the queues
 * this account works, and the way to the board's front page.
 *
 * The overview is the house's notice board, so the queues themselves are on
 * the board's own page (ADR 0044) and this line is all the board's work takes
 * here: led by its sign, above the house's panels, one number and one link.
 *
 * The line stays when nothing is waiting and says so in words: a line that
 * vanished would read the same as a capability that had been taken away. Its
 * number is the sum of the reads the front page makes, one per queue, so the
 * two can never disagree; a failed read says so and still carries the link.
 *
 * The link goes to the account's first board page in the band: the front
 * page, which lists every queue the number counts, where the account has one,
 * and otherwise the one board page it has - for the property manager, the
 * issue queue. Never to the front page of an account that is not offered it,
 * which would be a link to a refusal.
 */
export function BoardLine({
  capabilities,
  queues,
}: {
  capabilities: readonly string[];
  queues: readonly QueueId[];
}): ReactElement {
  const { t } = useTranslation();
  const label = useNavLabel();
  const signId = useId();
  // Keyed on the queues' names rather than the array, which is new on every
  // render: a new read function is a new question and would be asked again.
  const names = queues.join(" ");
  const read = useCallback(
    () => waitingIn(names.split(" ") as QueueId[]),
    [names],
  );
  const { state, retry } = useRead(read);
  // The band lists the front page first among the board's pages.
  const firstBoardPage = navItemsFor(capabilities).find(
    (item) => item.section === "board",
  );

  return (
    <div role="group" aria-labelledby={signId} className={ITEM_ROW}>
      <BoardMark audience={audienceOf(queues)} id={signId} />
      {state.kind === "loading" ? (
        <span role="status" className="text-body text-ink-muted">
          {t("app.loading")}
        </span>
      ) : state.kind === "failed" ? (
        <>
          <span className="text-body text-danger">
            {t("overview.board.failed")}
          </span>
          <button type="button" onClick={retry} className={QUIET_BUTTON}>
            {t("app.retry")}
          </button>
        </>
      ) : (
        <span className="text-body text-ink">
          {state.value.count === 0
            ? t("overview.board.none")
            : state.value.more
              ? t("overview.board.atLeast", { count: state.value.count })
              : t("overview.board.waiting", { count: state.value.count })}
        </span>
      )}
      {firstBoardPage === undefined ? null : (
        <Link
          to={firstBoardPage.to}
          className={`ml-auto text-body font-semibold ${ITEM_LINK}`}
        >
          {label(firstBoardPage)}
        </Link>
      )}
    </div>
  );
}

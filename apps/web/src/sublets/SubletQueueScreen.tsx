import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactElement,
} from "react";
import { useTranslation } from "react-i18next";

import type { Viewer } from "../api/instance";
import { fetchSubletQueue, type QueuedSubletApplication } from "../api/sublets";
import { BoardPage } from "../ui/BoardPage";
import { LoadFailure } from "../ui/LoadFailure";
import { SubletQueuePanel } from "./SubletQueuePanel";

export interface SubletQueueScreenProps {
  viewer: Viewer;
}

/** Everything one load produces, applied to the screen in one step. */
interface Loaded {
  ready: boolean;
  queue: readonly QueuedSubletApplication[];
  /**
   * Whether the read failed.
   *
   * A failed read has no rows, and a panel handed no rows says so in words: the
   * queue says nobody is waiting for the board's consent, which under BRL 7 kap.
   * 10 § is the board's own decision to make and a claim the association is
   * holding no request. The notice does not undo a sentence somebody has
   * already read, so a queue that failed is not drawn at all.
   */
  queueFailed: boolean;
}

const EMPTY: Loaded = { ready: false, queue: [], queueFailed: false };

/**
 * "Decide applications": the requests to let in andra hand, as a page of its
 * own under /board.
 *
 * `sublets:handle` is the board's, because BRL 7 kap. 10 § names the styrelse
 * as who gives the consent. Applying and following one's own application stay
 * on the house's page, which a member reaches holding sublets:apply
 * (ADR 0044).
 *
 * Hiding the queue is courtesy only. The API refuses the calls either way.
 */
export function SubletQueueScreen({
  viewer,
}: SubletQueueScreenProps): ReactElement {
  const { t } = useTranslation();

  const canHandle = viewer.capabilities.includes("sublets:handle");

  const [loaded, setLoaded] = useState<Loaded>(EMPTY);
  /**
   * Which read is the current one.
   *
   * Every act on this screen ends in a re-read, and two of them can be in flight
   * at once - the board answers one application while the answer to the one
   * before it is still coming back. Both answers are well formed, so the screen
   * cannot tell them apart by content; what it can say is that only the newest
   * read may be applied. Without that, whichever response happens to arrive last
   * wins, and the older one puts a closed application back as open.
   */
  const currentRead = useRef(0);

  const read = useCallback(async (): Promise<Loaded> => {
    const queue = canHandle ? await fetchSubletQueue() : null;

    return {
      ready: true,
      queue: queue?.ok === true ? queue.value.applications : [],
      queueFailed: queue?.ok === false,
    };
  }, [canHandle]);

  /**
   * Reads, and applies the answer only while it is still the newest one.
   *
   * Held in one place so the first read and every re-read are governed by the
   * same rule rather than each carrying its own version of it.
   */
  const reload = useCallback((): void => {
    const version = ++currentRead.current;
    void read().then((next) => {
      if (version === currentRead.current) {
        setLoaded(next);
      }
    });
  }, [read]);

  useEffect(() => {
    reload();
    /*
     * Leaving supersedes whatever is in flight, so a response that arrives after
     * the screen is gone is dropped by the same check that drops a superseded
     * one. One rule for both, rather than a mounted flag beside a version and
     * two ways for a read to be ignored.
     */
    return () => {
      currentRead.current += 1;
    };
  }, [reload]);

  const { ready, queue, queueFailed } = loaded;

  return (
    <BoardPage title={t("sublets.boardTitle")} offered={canHandle}>
      {queueFailed ? (
        <LoadFailure messageKey="sublets.loadFailed" onRetry={reload} />
      ) : null}

      {ready ? null : (
        <p role="status" className="text-body text-ink-muted">
          {t("sublets.loading")}
        </p>
      )}

      {ready && !queueFailed ? (
        <SubletQueuePanel applications={queue} onChanged={reload} />
      ) : null}
    </BoardPage>
  );
}

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactElement,
} from "react";
import { useTranslation } from "react-i18next";

import type { Viewer } from "../api/instance";
import { fetchKeyOrderQueue, type QueuedKeyOrder } from "../api/key-orders";
import { BoardPage } from "../ui/BoardPage";
import { LoadFailure } from "../ui/LoadFailure";
import { KeyOrderQueuePanel } from "./KeyOrderQueuePanel";

export interface KeyOrderQueueScreenProps {
  viewer: Viewer;
}

/** Everything one load produces, applied to the screen in one step. */
interface Loaded {
  ready: boolean;
  queue: readonly QueuedKeyOrder[];
  /**
   * Whether the read failed.
   *
   * A failed read has no rows, and a panel handed no rows says so in words: the
   * queue says nobody has ordered a key. That is a statement about the
   * association made from a request that never answered, and the notice does
   * not undo a sentence somebody has already read, so a queue that failed is
   * not drawn at all.
   */
  queueFailed: boolean;
}

const EMPTY: Loaded = { ready: false, queue: [], queueFailed: false };

/**
 * "Handle orders": the keys and tags ordered, as a page of its own under
 * /board.
 *
 * `keyOrders:handle` is the board's, because it is the association's own
 * property being given out and its building being opened. Placing an order and
 * following one's own stay on the house's page, which whoever lives here
 * reaches holding keyOrders:place - a board member who lives here among them
 * (ADR 0049).
 *
 * Hiding the queue is courtesy only. The API refuses the calls either way, and
 * the apartment an order names is checked against the register before anything
 * is written.
 */
export function KeyOrderQueueScreen({
  viewer,
}: KeyOrderQueueScreenProps): ReactElement {
  const { t } = useTranslation();

  const canHandle = viewer.capabilities.includes("keyOrders:handle");

  const [loaded, setLoaded] = useState<Loaded>(EMPTY);
  /**
   * Which read is the current one.
   *
   * Every act on this screen ends in a re-read, and two of them can be in flight
   * at once - the board records one handover while the answer to the one before
   * it is still coming back. Both answers are well formed, so the screen cannot
   * tell them apart by content; what it can say is that only the newest read may
   * be applied. Without that, whichever response happens to arrive last wins,
   * and the older one puts a closed order back as open.
   */
  const currentRead = useRef(0);

  const read = useCallback(async (): Promise<Loaded> => {
    const queue = canHandle ? await fetchKeyOrderQueue() : null;

    return {
      ready: true,
      queue: queue?.ok === true ? queue.value.orders : [],
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
    <BoardPage title={t("keyOrders.boardTitle")} offered={canHandle}>
      {queueFailed ? (
        <LoadFailure messageKey="keyOrders.loadFailed" onRetry={reload} />
      ) : null}

      {ready ? null : (
        <p role="status" className="text-body text-ink-muted">
          {t("keyOrders.loading")}
        </p>
      )}

      {ready && !queueFailed ? (
        <KeyOrderQueuePanel orders={queue} onChanged={reload} />
      ) : null}
    </BoardPage>
  );
}

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactElement,
} from "react";
import { useTranslation } from "react-i18next";

import type { Viewer } from "../api/instance";
import {
  fetchKeyOrderIntake,
  fetchKeyOrderQueue,
  type KeyOrderApartment,
  type OwnKeyOrder,
  type QueuedKeyOrder,
} from "../api/key-orders";
import { LoadFailure } from "../ui/LoadFailure";
import { KeyOrderQueuePanel } from "./KeyOrderQueuePanel";
import { OwnKeyOrdersPanel } from "./OwnKeyOrdersPanel";
import { PlaceKeyOrderPanel } from "./PlaceKeyOrderPanel";

export interface KeyOrdersScreenProps {
  viewer: Viewer;
}

/** Everything one load produces, applied to the screen in one step. */
interface Loaded {
  ready: boolean;
  apartments: readonly KeyOrderApartment[];
  own: readonly OwnKeyOrder[];
  queue: readonly QueuedKeyOrder[];
  /**
   * Which of the two reads failed, one flag each rather than one between them.
   *
   * A failed read has no rows, and a panel handed no rows says so in words: the
   * queue says no order is waiting and the resident's list says they have
   * ordered nothing. Both are statements about the association made from a
   * request that never answered, and the notice above them does not undo a
   * sentence somebody has already read. So a half that failed is not drawn at
   * all, and the half that succeeded is unaffected by it.
   */
  intakeFailed: boolean;
  queueFailed: boolean;
}

const EMPTY: Loaded = {
  ready: false,
  apartments: [],
  own: [],
  queue: [],
  intakeFailed: false,
  queueFailed: false,
};

/**
 * Ordering a key or a tag, and - for the board - the queue those orders arrive
 * in.
 *
 * What a viewer sees follows from their capabilities, and the two halves are
 * deliberately independent. `keyOrders:place` belongs to whoever lives here: no
 * statute gives anybody a right to a key, so a partner, an adult child and a
 * tenant hold it exactly as a member does - which is the opposite of the
 * subletting screen, where the act is the bostadsrattshavare's under BRL 7 kap.
 * 10 §. `keyOrders:handle` is the board's, because it is the association's own
 * property being given out and its building being opened.
 *
 * A board member lives here too and holds both, which is the ordinary case in a
 * cooperative and is why neither half assumes it is alone on the screen.
 *
 * Hiding a panel is courtesy only. The API refuses the calls either way, and the
 * apartment the order names is checked against the register before anything is
 * written.
 */
export function KeyOrdersScreen({
  viewer,
}: KeyOrdersScreenProps): ReactElement {
  const { t } = useTranslation();

  const canPlace = viewer.capabilities.includes("keyOrders:place");
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
    const [intake, queue] = await Promise.all([
      canPlace ? fetchKeyOrderIntake() : null,
      canHandle ? fetchKeyOrderQueue() : null,
    ]);

    return {
      ready: true,
      apartments: intake?.ok === true ? intake.value.apartments : [],
      own: intake?.ok === true ? intake.value.orders : [],
      queue: queue?.ok === true ? queue.value.orders : [],
      intakeFailed: intake?.ok === false,
      queueFailed: queue?.ok === false,
    };
  }, [canPlace, canHandle]);

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

  const { ready, apartments, own, queue, intakeFailed, queueFailed } = loaded;

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-5">
      <header className="flex flex-col gap-1">
        <h1 className="text-display">{t("keyOrders.title")}</h1>
        <p className="text-body text-ink-muted">{t("keyOrders.intro")}</p>
      </header>

      {intakeFailed || queueFailed ? (
        <LoadFailure messageKey="keyOrders.loadFailed" onRetry={reload} />
      ) : null}

      {ready ? null : (
        <p role="status" className="text-body text-ink-muted">
          {t("keyOrders.loading")}
        </p>
      )}

      {ready && canHandle && !queueFailed ? (
        <KeyOrderQueuePanel orders={queue} onChanged={reload} />
      ) : null}

      {ready && canPlace && !intakeFailed ? (
        <>
          <PlaceKeyOrderPanel apartments={apartments} onPlaced={reload} />
          <OwnKeyOrdersPanel orders={own} onChanged={reload} />
        </>
      ) : null}
    </div>
  );
}

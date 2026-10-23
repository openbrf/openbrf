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
  type KeyOrderApartment,
  type OwnKeyOrder,
} from "../api/key-orders";
import { LoadFailure } from "../ui/LoadFailure";
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
  /**
   * Whether the read failed.
   *
   * A failed read has no rows, and a panel handed no rows says so in words: the
   * resident's list says they have ordered nothing. That is a statement made
   * from a request that never answered, and the notice above it does not undo
   * a sentence somebody has already read, so a read that failed draws neither
   * panel.
   */
  intakeFailed: boolean;
}

const EMPTY: Loaded = {
  ready: false,
  apartments: [],
  own: [],
  intakeFailed: false,
};

/**
 * Ordering a key or a tag, and following one's own orders.
 *
 * `keyOrders:place` belongs to whoever lives here: no statute gives anybody a
 * right to a key, so a partner, an adult child and a tenant hold it exactly as
 * a member does - which is the opposite of the subletting screen, where the act
 * is the bostadsrattshavare's under BRL 7 kap. 10 §.
 *
 * One page, one audience. The queue those orders arrive in is the board's page
 * at /board/key-orders, so a board member who lives here reads the same screen
 * here as their neighbours do (ADR 0049).
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

  const [loaded, setLoaded] = useState<Loaded>(EMPTY);
  /**
   * Which read is the current one.
   *
   * Every act on this screen ends in a re-read, and two of them can be in flight
   * at once - a resident withdraws one order while the answer to the one before
   * it is still coming back. Both answers are well formed, so the screen cannot
   * tell them apart by content; what it can say is that only the newest read may
   * be applied. Without that, whichever response happens to arrive last wins,
   * and the older one puts a withdrawn order back as open.
   */
  const currentRead = useRef(0);

  const read = useCallback(async (): Promise<Loaded> => {
    const intake = canPlace ? await fetchKeyOrderIntake() : null;

    return {
      ready: true,
      apartments: intake?.ok === true ? intake.value.apartments : [],
      own: intake?.ok === true ? intake.value.orders : [],
      intakeFailed: intake?.ok === false,
    };
  }, [canPlace]);

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

  const { ready, apartments, own, intakeFailed } = loaded;

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-5">
      <header className="flex flex-col gap-1">
        <h1 className="text-display">{t("keyOrders.title")}</h1>
        <p className="text-body text-ink-muted">{t("keyOrders.intro")}</p>
      </header>

      {intakeFailed ? (
        <LoadFailure messageKey="keyOrders.loadFailed" onRetry={reload} />
      ) : null}

      {ready ? null : (
        <p role="status" className="text-body text-ink-muted">
          {t("keyOrders.loading")}
        </p>
      )}

      {ready && canPlace && !intakeFailed ? (
        <>
          <PlaceKeyOrderPanel apartments={apartments} onPlaced={reload} />
          <OwnKeyOrdersPanel orders={own} onChanged={reload} />
        </>
      ) : null}
    </div>
  );
}

import { useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";

import {
  answerKeyOrder,
  type KeyOrderer,
  type QueuedKeyOrder,
} from "../api/key-orders";
import {
  FIELD,
  HINT,
  LABEL,
  QUIET_BUTTON,
  SECONDARY_BUTTON,
} from "../ui/controls";
import { Notice } from "../ui/Notice";
import { NotRecorded } from "../ui/NotRecorded";
import { Panel } from "../ui/Panel";
import { useSaveAction } from "../ui/save-state";
import { keyOrderFailureKey, scannedKeyOrderParts } from "./key-order-failures";
import { KeyOrderStatusChip } from "./KeyOrderStatusChip";

export interface KeyOrderQueuePanelProps {
  orders: readonly QueuedKeyOrder[];
  onChanged: () => void;
}

/**
 * The queue the board works: what the households have asked for.
 *
 * Open orders first and oldest first within a status, which is the order the
 * server returns them in - the queue is worked from the top and the order that
 * has been waiting longest is the one to look at.
 *
 * Two outcomes and one act. Recording a handover says a key or a tag went to a
 * named person on a day, which is what the record exists for; declining says the
 * board is not giving one. The decline control is the visible difference from
 * the motion queue, which has none: refusing to take up a member's item is not
 * the board's to decide under EFL 6 kap. 15 §, and refusing a household a fourth
 * tag to the bike room plainly is.
 *
 * Neither control is offered once the order has closed, and the row states what
 * was answered instead. A handover that could be edited back would be a record
 * of nothing.
 *
 * Nothing here records what the key cost. That is a charge, with its own amount,
 * VAT treatment and export to whoever keeps the association's books.
 */
export function KeyOrderQueuePanel({
  orders,
  onChanged,
}: KeyOrderQueuePanelProps): ReactElement {
  const { t } = useTranslation();
  const [actingOn, setActingOn] = useState<string | null>(null);
  /** The note the board is writing with its answer, per row. */
  const [notes, setNotes] = useState<Record<string, string>>({});

  const answer = useSaveAction(answerKeyOrder, () => {
    setActingOn(null);
    onChanged();
  });

  const failure = answer.state.kind === "failed" ? answer.state.failure : null;
  const scanned = failure === null ? [] : scannedKeyOrderParts(failure);

  const send = (order: QueuedKeyOrder, handedOver: boolean) => {
    setActingOn(order.id);
    // An empty box is no note rather than an empty one: the server's schema
    // takes a non-empty string or null, and a field nobody typed in is null.
    const written = (notes[order.id] ?? "").trim();
    void answer.submit({
      orderId: order.id,
      handedOver,
      note: written === "" ? null : written,
    });
  };

  return (
    <Panel
      title={t("keyOrders.queue.title")}
      description={t("keyOrders.queue.description")}
      notice={
        failure === null ? (
          <Notice tone="info">{t("keyOrders.queue.charges")}</Notice>
        ) : (
          <Notice tone="danger" live>
            {t(keyOrderFailureKey(failure))}
            {scanned.length === 0 ? null : ` ${t("keyOrders.queue.noteField")}`}
          </Notice>
        )
      }
    >
      {orders.length === 0 ? (
        <p className="text-body text-ink-muted">{t("keyOrders.queue.empty")}</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {orders.map((order) => (
            <li
              key={order.id}
              className="flex flex-col gap-2 rounded-control border border-line bg-page px-3 py-3"
            >
              <div className="flex flex-wrap items-center gap-3">
                <span className="text-body font-semibold">
                  {t("keyOrders.mine.ordered", {
                    quantity: order.quantity,
                    kind: t(`keyOrders.kind.${order.kind}`),
                  })}
                </span>
                <KeyOrderStatusChip status={order.status} />
                <span className="ml-auto font-data text-data text-ink-muted">
                  {order.apartment === null
                    ? t("keyOrders.mine.apartmentGone")
                    : `${order.apartment.address} ${order.apartment.number}`}
                </span>
              </div>

              <p className="text-small text-ink-muted">
                {t("keyOrders.queue.orderedBy")} <Orderer of={order.orderer} />
              </p>

              {order.note === null ? null : (
                <p className="text-small whitespace-pre-line">{order.note}</p>
              )}

              {order.boardNote === null ? null : (
                <p className="text-small whitespace-pre-line text-ink-muted">
                  {t("keyOrders.queue.answered", { note: order.boardNote })}
                </p>
              )}

              {order.status === "SUBMITTED" ? (
                <div className="flex flex-col gap-3 border-t border-line pt-3">
                  <label className={LABEL}>
                    {t("keyOrders.queue.noteField")}
                    <textarea
                      className={`${FIELD} min-h-20 py-2`}
                      value={notes[order.id] ?? ""}
                      maxLength={1000}
                      onChange={(event) => {
                        setNotes({ ...notes, [order.id]: event.target.value });
                      }}
                    />
                  </label>
                  <p className={HINT}>{t("keyOrders.queue.noteHint")}</p>
                  <div className="flex flex-wrap gap-3">
                    <button
                      type="button"
                      className={SECONDARY_BUTTON}
                      // Names the order, because every row offers the same act
                      // and a screen reader hears one button per row otherwise.
                      aria-label={t("keyOrders.queue.handOverNamed", {
                        quantity: order.quantity,
                        kind: t(`keyOrders.kind.${order.kind}`),
                      })}
                      disabled={
                        actingOn === order.id && answer.state.kind === "saving"
                      }
                      onClick={() => {
                        send(order, true);
                      }}
                    >
                      {t("keyOrders.queue.handOver")}
                    </button>
                    <button
                      type="button"
                      className={QUIET_BUTTON}
                      aria-label={t("keyOrders.queue.declineNamed", {
                        quantity: order.quantity,
                        kind: t(`keyOrders.kind.${order.kind}`),
                      })}
                      disabled={
                        actingOn === order.id && answer.state.kind === "saving"
                      }
                      onClick={() => {
                        send(order, false);
                      }}
                    >
                      {t("keyOrders.queue.decline")}
                    </button>
                  </div>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

/**
 * Who ordered, as the board is told.
 *
 * A person with protected personal data is not named here even though the
 * board's own address book prints them: that register has a statutory reason to
 * and a queue has none. The apartment is still stated, because the key is for a
 * door rather than for a person and the board has to know which.
 */
function Orderer({ of }: { of: KeyOrderer }): ReactElement {
  const { t } = useTranslation();

  if (of.kind === "resident") {
    return <span>{of.name}</span>;
  }
  if (of.kind === "protected") {
    return <NotRecorded meaning={t("keyOrders.queue.ordererProtected")} />;
  }
  return <NotRecorded meaning={t("keyOrders.queue.ordererUnknown")} />;
}

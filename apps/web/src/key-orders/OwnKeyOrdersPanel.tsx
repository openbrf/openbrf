import { useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";

import {
  type KeyOrderKind,
  type OwnKeyOrder,
  reviseKeyOrder,
  withdrawKeyOrder,
} from "../api/key-orders";
import {
  FIELD,
  FIELD_DATA,
  LABEL,
  QUIET_BUTTON,
  SECONDARY_BUTTON,
} from "../ui/controls";
import { Notice } from "../ui/Notice";
import { Panel } from "../ui/Panel";
import { useSaveAction } from "../ui/save-state";
import { keyOrderFailureKey, scannedKeyOrderParts } from "./key-order-failures";
import { KeyOrderStatusChip } from "./KeyOrderStatusChip";

export interface OwnKeyOrdersPanelProps {
  orders: readonly OwnKeyOrder[];
  onChanged: () => void;
}

const KINDS: readonly KeyOrderKind[] = ["KEY", "TAG"];

/**
 * What this resident has ordered.
 *
 * Changing and withdrawing are offered only while the order is still open,
 * because that is the only state the API accepts either in: a key that has been
 * handed over is in somebody's pocket, and a record that could be edited back
 * would be a record of nothing.
 *
 * A declined or withdrawn order stays on the list with its date. The record that
 * the household asked is theirs, and nothing here deletes a row - the purge
 * does, a year after the order closed.
 */
export function OwnKeyOrdersPanel({
  orders,
  onChanged,
}: OwnKeyOrdersPanelProps): ReactElement {
  const { t } = useTranslation();
  /** Which row is mid-request, so only that row reads as busy. */
  const [actingOn, setActingOn] = useState<string | null>(null);
  /** Which row is open for editing, and the draft in it. */
  const [editing, setEditing] = useState<{
    id: string;
    kind: KeyOrderKind;
    quantity: number;
    note: string;
  } | null>(null);

  const withdraw = useSaveAction(withdrawKeyOrder, () => {
    setActingOn(null);
    onChanged();
  });
  const revise = useSaveAction(reviseKeyOrder, () => {
    setActingOn(null);
    setEditing(null);
    onChanged();
  });

  const failure =
    withdraw.state.kind === "failed"
      ? withdraw.state.failure
      : revise.state.kind === "failed"
        ? revise.state.failure
        : null;
  const scanned = failure === null ? [] : scannedKeyOrderParts(failure);

  return (
    <Panel
      title={t("keyOrders.mine.title")}
      description={t("keyOrders.mine.description")}
      notice={
        failure === null ? null : (
          <Notice tone="danger" live>
            {t(keyOrderFailureKey(failure))}
            {scanned.length === 0 ? null : ` ${t("keyOrders.place.noteField")}`}
          </Notice>
        )
      }
    >
      {orders.length === 0 ? (
        <p className="text-body text-ink-muted">{t("keyOrders.mine.empty")}</p>
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

              {order.note === null ? null : (
                <p className="text-small whitespace-pre-line">{order.note}</p>
              )}

              {order.boardNote === null ? null : (
                <p className="text-small whitespace-pre-line text-ink-muted">
                  {t("keyOrders.mine.boardSaid", { note: order.boardNote })}
                </p>
              )}

              {order.status === "SUBMITTED" ? (
                editing?.id === order.id ? (
                  <form
                    className="flex flex-col gap-3 border-t border-line pt-3"
                    onSubmit={(event) => {
                      event.preventDefault();
                      setActingOn(order.id);
                      const note = editing.note.trim();
                      void revise.submit({
                        orderId: order.id,
                        kind: editing.kind,
                        quantity: editing.quantity,
                        note: note === "" ? null : note,
                      });
                    }}
                  >
                    <div className="flex flex-wrap gap-4">
                      <label className={`${LABEL} max-w-64`}>
                        {t("keyOrders.place.kindField")}
                        <select
                          className={FIELD}
                          value={editing.kind}
                          onChange={(event) => {
                            setEditing({
                              ...editing,
                              kind: event.target.value as KeyOrderKind,
                            });
                          }}
                        >
                          {KINDS.map((kind) => (
                            <option key={kind} value={kind}>
                              {t(`keyOrders.kind.${kind}`)}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label className={`${LABEL} max-w-32`}>
                        {t("keyOrders.place.quantityField")}
                        <input
                          type="number"
                          className={FIELD_DATA}
                          value={editing.quantity}
                          min={1}
                          max={10}
                          required
                          onChange={(event) => {
                            setEditing({
                              ...editing,
                              quantity: Number(event.target.value),
                            });
                          }}
                        />
                      </label>
                    </div>
                    <label className={LABEL}>
                      {t("keyOrders.place.noteField")}
                      <textarea
                        className={`${FIELD} min-h-20 py-2`}
                        value={editing.note}
                        maxLength={1000}
                        onChange={(event) => {
                          setEditing({ ...editing, note: event.target.value });
                        }}
                      />
                    </label>
                    <div className="flex flex-wrap gap-3">
                      <button
                        type="submit"
                        className={SECONDARY_BUTTON}
                        disabled={
                          actingOn === order.id &&
                          revise.state.kind === "saving"
                        }
                      >
                        {actingOn === order.id && revise.state.kind === "saving"
                          ? t("keyOrders.mine.saving")
                          : t("keyOrders.mine.save")}
                      </button>
                      <button
                        type="button"
                        className={QUIET_BUTTON}
                        onClick={() => {
                          revise.reset();
                          setEditing(null);
                        }}
                      >
                        {t("keyOrders.mine.cancelEdit")}
                      </button>
                    </div>
                  </form>
                ) : (
                  <div className="flex flex-wrap gap-3">
                    <button
                      type="button"
                      className={QUIET_BUTTON}
                      // Names the order, because every row offers the same act
                      // and a screen reader hears one button per row otherwise.
                      aria-label={t("keyOrders.mine.editNamed", {
                        quantity: order.quantity,
                        kind: t(`keyOrders.kind.${order.kind}`),
                      })}
                      onClick={() => {
                        withdraw.reset();
                        revise.reset();
                        setEditing({
                          id: order.id,
                          kind: order.kind,
                          quantity: order.quantity,
                          note: order.note ?? "",
                        });
                      }}
                    >
                      {t("keyOrders.mine.edit")}
                    </button>
                    <button
                      type="button"
                      className={QUIET_BUTTON}
                      aria-label={t("keyOrders.mine.withdrawNamed", {
                        quantity: order.quantity,
                        kind: t(`keyOrders.kind.${order.kind}`),
                      })}
                      disabled={
                        actingOn === order.id &&
                        withdraw.state.kind === "saving"
                      }
                      onClick={() => {
                        // The other act's state is cleared first, so a refusal
                        // it met does not sit over this one's outcome.
                        revise.reset();
                        setActingOn(order.id);
                        void withdraw.submit({ orderId: order.id });
                      }}
                    >
                      {actingOn === order.id && withdraw.state.kind === "saving"
                        ? t("keyOrders.mine.withdrawing")
                        : t("keyOrders.mine.withdraw")}
                    </button>
                  </div>
                )
              ) : (
                <p className="text-small text-ink-muted">
                  {t(
                    order.status === "HANDED_OVER"
                      ? "keyOrders.mine.handedOverOn"
                      : "keyOrders.mine.closedOn",
                    { date: order.closedAt?.slice(0, 10) ?? "" },
                  )}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

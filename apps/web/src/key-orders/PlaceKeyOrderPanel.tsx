import { useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";

import {
  type KeyOrderApartment,
  type KeyOrderKind,
  placeKeyOrder,
} from "../api/key-orders";
import { FIELD, FIELD_DATA, HINT, LABEL, PRIMARY_BUTTON } from "../ui/controls";
import { Notice } from "../ui/Notice";
import { Panel } from "../ui/Panel";
import { useSaveAction } from "../ui/save-state";
import { keyOrderFailureKey, scannedKeyOrderParts } from "./key-order-failures";

export interface PlaceKeyOrderPanelProps {
  /** The apartments this resident lives in, as the server derived them. */
  apartments: readonly KeyOrderApartment[];
  onPlaced: () => void;
}

/** The two kinds, in the order the picker offers them. */
const KINDS: readonly KeyOrderKind[] = ["KEY", "TAG"];

const EMPTY = { kind: "KEY" as KeyOrderKind, quantity: 1, note: "" };

/**
 * Ordering a key or a tag.
 *
 * Offered to whoever lives here, which is the decision this module makes
 * differently from the subletting form beside it: no statute gives anybody a
 * right to a key, so `keyOrders:place` follows residency the way `bookings:book`
 * does and a partner, an adult child or a tenant orders exactly as a member
 * does.
 *
 * The apartment is a select over the caller's own homes and never over the
 * register. Most households hold one, so the control states it rather than
 * offering a choice of one.
 *
 * There is no price on this form and none in the answer. What a key costs the
 * member is a charge recorded elsewhere, and a figure quoted here would be a
 * second answer to what the household owes - which is why the panel says the
 * board will tell them rather than pretending to know.
 */
export function PlaceKeyOrderPanel({
  apartments,
  onPlaced,
}: PlaceKeyOrderPanelProps): ReactElement {
  const { t } = useTranslation();
  const [draft, setDraft] = useState(EMPTY);
  const [apartmentId, setApartmentId] = useState("");

  const send = useSaveAction(placeKeyOrder, () => {
    setDraft(EMPTY);
    onPlaced();
  });

  const failure = send.state.kind === "failed" ? send.state.failure : null;
  /*
   * Which fields the scan caught, by name and never by value. The refusal
   * carries an offset too, and it is deliberately not shown: a character
   * position in a textarea is not something a person can act on.
   */
  const scanned = failure === null ? [] : scannedKeyOrderParts(failure);
  const chosen = apartmentId === "" ? (apartments[0]?.id ?? "") : apartmentId;

  if (apartments.length === 0) {
    /*
     * Somebody holding the capability and no residency today - an administrator,
     * or a household between a move-out and the register catching up. A form
     * that could only be refused is a worse way of saying so than a sentence.
     */
    return (
      <Panel
        title={t("keyOrders.place.title")}
        description={t("keyOrders.place.description")}
      >
        <p className="text-body text-ink-muted">
          {t("keyOrders.place.noApartment")}
        </p>
      </Panel>
    );
  }

  return (
    <Panel
      title={t("keyOrders.place.title")}
      description={t("keyOrders.place.description")}
      notice={
        failure === null ? (
          <Notice tone="info">{t("keyOrders.place.cost")}</Notice>
        ) : (
          <Notice tone="danger" live>
            {t(keyOrderFailureKey(failure))}
            {scanned.length === 0
              ? null
              : ` ${scanned
                  .map((part) =>
                    part === "note"
                      ? t("keyOrders.place.noteField")
                      : t("keyOrders.queue.noteField"),
                  )
                  .join(", ")}`}
          </Notice>
        )
      }
      actions={
        <>
          <button
            type="submit"
            form="place-key-order"
            className={PRIMARY_BUTTON}
            disabled={send.state.kind === "saving"}
          >
            {send.state.kind === "saving"
              ? t("keyOrders.place.sending")
              : t("keyOrders.place.action")}
          </button>
          {send.state.kind === "saved" ? (
            <Notice tone="ok" live>
              {t("keyOrders.place.sent")}
            </Notice>
          ) : null}
        </>
      }
    >
      <form
        id="place-key-order"
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          const note = draft.note.trim();
          void send.submit({
            apartmentId: chosen,
            kind: draft.kind,
            quantity: draft.quantity,
            // An empty box is no note rather than an empty one: the server's
            // schema takes a non-empty string or null.
            note: note === "" ? null : note,
          });
        }}
      >
        <label className={`${LABEL} max-w-96`}>
          {t("keyOrders.place.apartmentField")}
          {/* The data face, so the numbers sit on the mono grid DESIGN.md puts
              register data on. */}
          <select
            className={FIELD_DATA}
            value={chosen}
            onChange={(event) => {
              setApartmentId(event.target.value);
            }}
          >
            {apartments.map((apartment) => (
              <option key={apartment.id} value={apartment.id}>
                {`${apartment.address} ${apartment.number}`}
              </option>
            ))}
          </select>
        </label>

        <div className="flex flex-wrap gap-4">
          <label className={`${LABEL} max-w-64`}>
            {t("keyOrders.place.kindField")}
            <select
              className={FIELD}
              value={draft.kind}
              onChange={(event) => {
                setDraft({
                  ...draft,
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
              value={draft.quantity}
              min={1}
              max={10}
              required
              onChange={(event) => {
                setDraft({ ...draft, quantity: Number(event.target.value) });
              }}
            />
          </label>
        </div>

        <label className={LABEL}>
          {t("keyOrders.place.noteField")}
          <textarea
            className={`${FIELD} min-h-24 py-2`}
            value={draft.note}
            maxLength={1000}
            onChange={(event) => {
              setDraft({ ...draft, note: event.target.value });
            }}
          />
        </label>
        {/* Never the only carrier of a requirement: the note is optional, and
            the sentence says what it is for rather than that it is needed. */}
        <p className={HINT}>{t("keyOrders.place.noteHint")}</p>
      </form>
    </Panel>
  );
}

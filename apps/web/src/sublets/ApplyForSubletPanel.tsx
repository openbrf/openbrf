import { useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";

import { applyForSublet, type SubletApartment } from "../api/sublets";
import { FIELD, FIELD_DATA, HINT, LABEL, PRIMARY_BUTTON } from "../ui/controls";
import { Notice } from "../ui/Notice";
import { Panel } from "../ui/Panel";
import { useSaveAction } from "../ui/save-state";
import { scannedSubletParts, subletFailureKey } from "./sublet-failures";

export interface ApplyForSubletPanelProps {
  /** The apartments this member holds, as the server derived them. */
  apartments: readonly SubletApartment[];
  onApplied: () => void;
}

const EMPTY = { periodFrom: "", periodTo: "", reason: "" };

/**
 * Asking the board's consent to let one's apartment in andra hand.
 *
 * The form is offered to whoever the server let onto this screen, which under
 * BRL 7 kap. 10 § is a bostadsrattshavare: `sublets:apply` is derived from
 * membership rather than from residency, so a partner, an adult child or a
 * tenant never reaches it. The server asks the register again about the
 * apartment named in the request, so hiding or showing this panel is courtesy
 * either way.
 *
 * ## What the form says rather than decides
 *
 * Whether the letting is for sjalvstandigt brukande at all. 10 § andra stycket
 * (Lag 2026:776) makes a letting of the apartment or part of it always count as
 * independent use where the holder does not use it as a permanent home or
 * otherwise to a beaktansvard extent - a fact about how somebody lives that the
 * platform does not hold. So the rule is stated here and the member applies or
 * does not; nothing on this screen decides that consent was needed.
 *
 * And what happens if the board refuses. 11 § lets the member let anyway if the
 * rent tribunal permits, and a member who reads only "refused" has been told the
 * smaller half. It is stated on the form rather than after the answer, because
 * somebody weighing whether to apply at all is who needs to know it.
 *
 * ## The apartment
 *
 * A select over the caller's own apartments and never over the register. Most
 * households hold one, so the control states it rather than offering a choice
 * of one - and where somebody holds two, the choice is between homes they hold
 * rather than a list of the building.
 */
export function ApplyForSubletPanel({
  apartments,
  onApplied,
}: ApplyForSubletPanelProps): ReactElement {
  const { t } = useTranslation();
  const [draft, setDraft] = useState(EMPTY);
  const [apartmentId, setApartmentId] = useState("");

  const send = useSaveAction(applyForSublet, () => {
    setDraft(EMPTY);
    onApplied();
  });

  const failure = send.state.kind === "failed" ? send.state.failure : null;
  /*
   * Which fields the scan caught, by name and never by value.
   *
   * The refusal carries an offset too, and it is deliberately not shown: a
   * character position in a textarea is not something a person can act on, while
   * "there is a personal identity number in the reason" is.
   */
  const scanned = failure === null ? [] : scannedSubletParts(failure);
  const chosen = apartmentId === "" ? (apartments[0]?.id ?? "") : apartmentId;

  if (apartments.length === 0) {
    /*
     * A member holding no apartment today. The capability follows membership and
     * membership follows an active residency, so this is the moment between a
     * sale and the register catching up - or a seat granted by hand. A form that
     * could only be refused is a worse way of saying so than a sentence.
     */
    return (
      <Panel
        title={t("sublets.apply.title")}
        description={t("sublets.apply.description")}
      >
        <p className="text-body text-ink-muted">
          {t("sublets.apply.noApartment")}
        </p>
      </Panel>
    );
  }

  return (
    <Panel
      title={t("sublets.apply.title")}
      description={t("sublets.apply.description")}
      notice={
        failure === null ? (
          <Notice tone="info">{t("sublets.apply.statute")}</Notice>
        ) : (
          <Notice tone="danger" live>
            {t(subletFailureKey(failure))}
            {scanned.length === 0
              ? null
              : ` ${scanned
                  .map((part) =>
                    part === "reason"
                      ? t("sublets.apply.reasonField")
                      : t("sublets.queue.noteField"),
                  )
                  .join(", ")}`}
          </Notice>
        )
      }
      actions={
        <>
          <button
            type="submit"
            form="apply-for-sublet"
            className={PRIMARY_BUTTON}
            disabled={send.state.kind === "saving"}
          >
            {send.state.kind === "saving"
              ? t("sublets.apply.sending")
              : t("sublets.apply.action")}
          </button>
          {send.state.kind === "saved" ? (
            <Notice tone="ok" live>
              {t("sublets.apply.sent")}
            </Notice>
          ) : null}
        </>
      }
    >
      <form
        id="apply-for-sublet"
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          void send.submit({ ...draft, apartmentId: chosen });
        }}
      >
        <label className={`${LABEL} max-w-96`}>
          {t("sublets.apply.apartmentField")}
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
          <label className={`${LABEL} max-w-48`}>
            {t("sublets.apply.fromField")}
            <input
              type="date"
              className={FIELD_DATA}
              value={draft.periodFrom}
              required
              onChange={(event) => {
                setDraft({ ...draft, periodFrom: event.target.value });
              }}
            />
          </label>

          <label className={`${LABEL} max-w-48`}>
            {t("sublets.apply.toField")}
            <input
              type="date"
              className={FIELD_DATA}
              value={draft.periodTo}
              required
              onChange={(event) => {
                setDraft({ ...draft, periodTo: event.target.value });
              }}
            />
          </label>
        </div>
        {/* Never the only carrier of the rule: the server refuses a period whose
            end is before its start, and a permission the rent tribunal gives is
            limited in time (BRL 7 kap. 11 §), so an end date is asked for. */}
        <p className={HINT}>{t("sublets.apply.periodHint")}</p>

        <label className={LABEL}>
          {t("sublets.apply.reasonField")}
          <textarea
            className={`${FIELD} min-h-32 py-2`}
            value={draft.reason}
            maxLength={4000}
            required
            onChange={(event) => {
              setDraft({ ...draft, reason: event.target.value });
            }}
          />
        </label>
        <p className={HINT}>{t("sublets.apply.reasonHint")}</p>
      </form>
    </Panel>
  );
}

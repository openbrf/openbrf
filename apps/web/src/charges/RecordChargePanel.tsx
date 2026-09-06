import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import type { ReactElement } from "react";

import {
  FIELD,
  FIELD_DATA,
  HINT,
  LABEL,
  PANEL,
  PRIMARY_BUTTON,
} from "../ui/controls";
import { Notice } from "../ui/Notice";
import { useSaveAction } from "../ui/save-state";
import { chargeFailureKey, refusedIdentityNumbers } from "./charge-failures";
import type { ChargeablePerson, ChargeParties } from "./charge-parties";
import {
  type ChargeRow,
  recordCharge,
  type VatTreatment,
  VAT_TREATMENTS,
} from "./charges-api";

/**
 * Recording one charge.
 *
 * ## The charged party is a choice, not two fields
 *
 * The server refuses a charge naming both a person and an apartment, so the form
 * offers one control at a time: a radio decides which kind of party, and the
 * select under it lists that kind. A form with two selects would let a board
 * member fill both in and be refused for something they were invited to do,
 * which is the failure this module's own screens are not allowed to have.
 *
 * ## The VAT rate appears with the treatment that has one
 *
 * The rate is offered only when the charge carries tax, because an exempt charge
 * with a rate on it is refused. The number is entered rather than picked from a
 * list of rates: which rates are in force is mervardesskattelagen's question and
 * moves by amendment, and a select would refuse a board a rate their bookkeeper
 * told them to apply.
 *
 * ## The hand-over date
 *
 * Offered on the form, because the board often records a charge that has already
 * gone over with the last batch. It says when the basis left the association and
 * nothing about payment - the sentence under it says so, because that is the one
 * thing about this screen a reader is most likely to assume wrongly.
 */
/**
 * What one person's option reads.
 *
 * The name, and where they live where the register knows: two households share a
 * surname often enough that the address is what tells them apart. Where even
 * that is not enough - two people of one name in one flat, which a register can
 * hold - the day they moved in is added, because an option that read the same
 * for both would ask a board to choose between two identical rows.
 *
 * The date is added only to the rows that need it. Putting it on every option
 * would push the thing a board is actually reading off the end of the line.
 */
function personOption(
  person: ChargeablePerson,
  t: TFunction<"translation">,
): string {
  const shown =
    person.apartment === null
      ? person.name
      : `${person.name} - ${person.apartment}`;

  return person.ambiguous && person.movedInOn !== null
    ? t("charges.record.personMovedIn", {
        person: shown,
        movedInOn: person.movedInOn,
      })
    : shown;
}

export function RecordChargePanel({
  parties,
  today,
  onRecorded,
}: {
  parties: ChargeParties;
  /** "YYYY-MM-DD". The default date, and the latest one the form offers. */
  today: string;
  onRecorded: (row: ChargeRow) => void;
}): ReactElement {
  const { t } = useTranslation();

  const [partyKind, setPartyKind] = useState<"person" | "apartment">("person");
  const [personId, setPersonId] = useState("");
  const [apartmentId, setApartmentId] = useState("");
  const [chargedOn, setChargedOn] = useState(today);
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [vatTreatment, setVatTreatment] = useState<VatTreatment>("EXEMPT");
  const [vatRatePercent, setVatRatePercent] = useState("");
  const [handedToManagerOn, setHandedToManagerOn] = useState("");

  const { state, submit } = useSaveAction(recordCharge, (row) => {
    // The party and the date stay: a board recording a batch of charges enters
    // several against one day, and clearing them would make the second one a
    // full re-entry.
    setAmount("");
    setReason("");
    onRecorded(row);
  });

  const chosen = partyKind === "person" ? personId : apartmentId;

  return (
    <section className={`${PANEL} flex flex-col gap-5 print:hidden`}>
      <div className="flex flex-col gap-1">
        <h2 className="text-title">{t("charges.record.heading")}</h2>
        <p className={HINT}>{t("charges.record.description")}</p>
      </div>

      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          void submit({
            personId: partyKind === "person" ? personId : null,
            apartmentId: partyKind === "apartment" ? apartmentId : null,
            chargedOn,
            amount,
            reason,
            vatTreatment,
            vatRatePercent:
              vatTreatment === "RATE" && vatRatePercent !== ""
                ? Number(vatRatePercent)
                : null,
            handedToManagerOn:
              handedToManagerOn === "" ? null : handedToManagerOn,
          });
        }}
      >
        <fieldset className="flex flex-col gap-2">
          <legend className="text-label text-ink-muted uppercase">
            {t("charges.record.party.legend")}
          </legend>
          <div className="flex flex-wrap gap-4">
            {(["person", "apartment"] as const).map((kind) => (
              <label
                key={kind}
                className="flex min-h-11 items-center gap-2 text-small text-ink"
              >
                <input
                  type="radio"
                  name="charge-party-kind"
                  value={kind}
                  checked={partyKind === kind}
                  onChange={() => {
                    setPartyKind(kind);
                  }}
                  className="size-4 accent-trust"
                />
                {t(`charges.record.party.${kind}`)}
              </label>
            ))}
          </div>
          <p className={HINT}>{t("charges.record.party.hint")}</p>
        </fieldset>

        {partyKind === "person" ? (
          <label className={LABEL}>
            {t("charges.record.person")}
            <select
              value={personId}
              onChange={(event) => {
                setPersonId(event.target.value);
              }}
              required
              className={FIELD}
            >
              <option value="">{t("charges.record.choose")}</option>
              {parties.persons.map((person) => (
                <option key={person.personId} value={person.personId}>
                  {personOption(person, t)}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <label className={LABEL}>
            {t("charges.record.apartment")}
            <select
              value={apartmentId}
              onChange={(event) => {
                setApartmentId(event.target.value);
              }}
              required
              className={FIELD}
            >
              <option value="">{t("charges.record.choose")}</option>
              {parties.apartments.map((apartment) => (
                <option
                  key={apartment.apartmentId}
                  value={apartment.apartmentId}
                >
                  {apartment.label}
                </option>
              ))}
            </select>
          </label>
        )}

        <div className="grid gap-4 sm:grid-cols-2">
          <label className={LABEL}>
            {t("charges.record.chargedOn")}
            <input
              type="date"
              value={chargedOn}
              max={today}
              onChange={(event) => {
                setChargedOn(event.target.value);
              }}
              required
              className={FIELD_DATA}
            />
          </label>

          <label className={LABEL}>
            {t("charges.record.amount")}
            <input
              type="text"
              inputMode="decimal"
              value={amount}
              onChange={(event) => {
                setAmount(event.target.value);
              }}
              required
              className={FIELD_DATA}
            />
          </label>
        </div>

        <label className={LABEL}>
          {t("charges.record.reason")}
          <input
            type="text"
            value={reason}
            maxLength={500}
            onChange={(event) => {
              setReason(event.target.value);
            }}
            required
            className={FIELD}
          />
        </label>

        <div className="grid gap-4 sm:grid-cols-2">
          <label className={LABEL}>
            {t("charges.record.vatTreatment")}
            <select
              value={vatTreatment}
              onChange={(event) => {
                setVatTreatment(event.target.value as VatTreatment);
              }}
              className={FIELD}
            >
              {VAT_TREATMENTS.map((treatment) => (
                <option key={treatment} value={treatment}>
                  {t(`charges.vat.${treatment}`)}
                </option>
              ))}
            </select>
          </label>

          {vatTreatment === "RATE" ? (
            <label className={LABEL}>
              {t("charges.record.vatRatePercent")}
              <input
                type="number"
                min={1}
                max={100}
                step={1}
                value={vatRatePercent}
                onChange={(event) => {
                  setVatRatePercent(event.target.value);
                }}
                required
                className={FIELD_DATA}
              />
            </label>
          ) : null}
        </div>

        <label className={LABEL}>
          {t("charges.record.handedToManagerOn")}
          <input
            type="date"
            value={handedToManagerOn}
            max={today}
            onChange={(event) => {
              setHandedToManagerOn(event.target.value);
            }}
            className={FIELD_DATA}
          />
          <span className={HINT}>{t("charges.record.handedHint")}</span>
        </label>

        <div className="flex flex-wrap items-center gap-3">
          <button
            type="submit"
            disabled={state.kind === "saving" || chosen === ""}
            className={PRIMARY_BUTTON}
          >
            {state.kind === "saving"
              ? t("charges.record.saving")
              : t("charges.record.submit")}
          </button>
          {state.kind === "saved" ? (
            <span role="status" className={HINT}>
              {t("charges.record.saved")}
            </span>
          ) : null}
        </div>

        {state.kind === "failed" ? (
          <Notice tone="danger" live>
            {t(chargeFailureKey(state.failure))}
            {refusedIdentityNumbers(state.failure) > 0
              ? ` ${t("charges.errors.personalIdentityNumberCount", {
                  count: refusedIdentityNumbers(state.failure),
                })}`
              : null}
          </Notice>
        ) : null}
      </form>
    </section>
  );
}

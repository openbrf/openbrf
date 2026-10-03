import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import type { ReactElement } from "react";

import { AccountingBasisPanel } from "../accounting/AccountingBasisPanel";
import { localDayNow } from "../bookings/booking-calendar";
import type { TranslationKey } from "../i18n/translation-key";
import {
  CELL,
  DATA_CELL,
  DOCUMENT,
  DOCUMENT_ATTRIBUTE,
  HEAD_CELL,
  ROW,
  STAMP,
  TABLE,
  TABLE_SCROLL,
} from "../registers/document";
import {
  FIELD,
  FIELD_DATA,
  HINT,
  LABEL,
  PANEL,
  PRIMARY_BUTTON,
  QUIET_BUTTON,
  SECONDARY_BUTTON,
} from "../ui/controls";
import { LoadFailure } from "../ui/LoadFailure";
import { formatAmount, normalizeAmount, vatRateOf } from "../ui/money";
import { Notice } from "../ui/Notice";
import { NotRecorded } from "../ui/NotRecorded";
import { feeFailureKey } from "./fee-failures";
import {
  type FeeKind,
  type FeeNoticeExport,
  type FeeRegister,
  type FeeVatTreatment,
  fetchFeeRegister,
  recordFee,
  removeFee,
} from "./fees-api";
import { FeeNoticeDocument } from "./FeeNoticeDocument";
import { FeeNotificationsPanel } from "./FeeNotificationsPanel";
import { suggestMonthlyAmounts } from "./participation-share";

/**
 * The fees the apartments pay, and the notices issued from them (avgifter).
 *
 * Two things standing together on one screen, because they are one job: what
 * each apartment pays, and the act of billing a period of it. The register is
 * the document half - printed the way the debiting list and the register
 * extracts are - and the panels above it are where the board works.
 *
 * ## No payment, anywhere
 *
 * There is no paid column, no outstanding figure and no status. The accounting
 * system settles the debt, and a second answer to whether something has been
 * paid is worse than none. The screen says so out loud, because this is exactly
 * where a board expects to see it.
 *
 * ## The andelstal aid suggests and never decides
 *
 * A board types a year's total, sees what each apartment's participation share
 * would come to per month, and accepts or overwrites each figure. Nothing is
 * derived at read time and no total is stored: BRL 9 kap. 5 § forsta stycket 5
 * leaves the basis for calculating the arsavgift to each association's stadgar
 * and 9 kap. 13 § leaves fixing the amounts to its board. The panel says so, so
 * that a board cannot come to believe the platform is maintaining an
 * apportionment it is not.
 *
 * ## Refusals are read at the render site
 *
 * `t` is a new function on some renders, so it is never called in an effect or
 * stored in state. A refusal is kept as its key and translated where it is
 * shown, which is what keeps the reads below from looping.
 */

/**
 * Today as "YYYY-MM-DD" on the association's own calendar.
 *
 * Read in the association's time zone and never off the UTC instant. Sweden is
 * an hour or two ahead of UTC, so for the first hour or two of every day the UTC
 * date is still yesterday: the register would open on the day before, and on
 * the first of a month the default below would name a month already begun.
 */
function today(now: Date = new Date()): string {
  return localDayNow(now);
}

/**
 * The first day of next month on the association's own calendar - the day a
 * rate most often starts on.
 *
 * Built from the association's own day rather than from the browser's local
 * getters, which answer in whatever zone the reader's machine is set to.
 */
function firstOfNextMonth(now: Date = new Date()): string {
  const [year = 0, month = 0] = localDayNow(now).split("-").map(Number);
  const rolled =
    month === 12 ? { year: year + 1, month: 1 } : { year, month: month + 1 };
  return `${String(rolled.year)}-${String(rolled.month).padStart(2, "0")}-01`;
}

const KINDS: readonly FeeKind[] = [
  "ANNUAL_FEE",
  "PARKING_SPACE",
  "STORAGE_SPACE",
];

const KIND_LABEL: Readonly<Record<FeeKind, TranslationKey>> = {
  ANNUAL_FEE: "fees.kind.ANNUAL_FEE",
  PARKING_SPACE: "fees.kind.PARKING_SPACE",
  STORAGE_SPACE: "fees.kind.STORAGE_SPACE",
};

const VAT_LABEL: Readonly<Record<FeeVatTreatment, TranslationKey>> = {
  EXEMPT: "fees.vat.EXEMPT",
  RATE: "fees.vat.RATE",
};

export function FeesScreen(): ReactElement {
  const { t, i18n } = useTranslation();

  const [on, setOn] = useState(() => today());
  const [register, setRegister] = useState<FeeRegister | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [forbidden, setForbidden] = useState(false);
  const [refusal, setRefusal] = useState<TranslationKey | null>(null);
  const [reload, setReload] = useState(0);

  const [apartmentId, setApartmentId] = useState("");
  const [kind, setKind] = useState<FeeKind>("ANNUAL_FEE");
  const [appliesFrom, setAppliesFrom] = useState(() => firstOfNextMonth());
  const [monthlyAmount, setMonthlyAmount] = useState("");
  const [vatTreatment, setVatTreatment] = useState<FeeVatTreatment>("EXEMPT");
  const [vatRatePercent, setVatRatePercent] = useState("");
  const [amountInvalid, setAmountInvalid] = useState(false);
  const [rateInvalid, setRateInvalid] = useState(false);
  const amountErrorId = useId();
  const rateErrorId = useId();
  const [recording, setRecording] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);
  const amountRef = useRef<HTMLInputElement>(null);
  // The control that had focus when the form was locked. A disabled control
  // drops focus to the page, so it is given back once the form is open again.
  const focusedBeforeLock = useRef<HTMLElement | null>(null);

  const [yearlyTotal, setYearlyTotal] = useState("");
  const [aidOpen, setAidOpen] = useState(false);
  const [notices, setNotices] = useState<FeeNoticeExport | null>(null);

  const load = useCallback((): void => {
    setReload((generation) => generation + 1);
  }, []);

  useEffect(() => {
    let cancelled = false;
    /*
     * An emptied date field is not a day yet. Asked for, it came back as a
     * failed read, with a retry that asked for the same empty day again.
     */
    if (on === "") {
      return;
    }

    void (async () => {
      const result = await fetchFeeRegister(on);
      if (cancelled) {
        return;
      }
      setLoading(false);
      if (result.ok) {
        setRegister(result.value);
        setFailed(false);
        setForbidden(false);
        return;
      }
      if (result.failure.status === 403) {
        setForbidden(true);
        setFailed(false);
        setRegister(null);
        return;
      }
      setFailed(true);
    })();

    return () => {
      cancelled = true;
    };
  }, [on, reload]);

  useEffect(() => {
    if (recording) {
      return;
    }
    const target = focusedBeforeLock.current;
    focusedBeforeLock.current = null;
    if (target === null) {
      return;
    }
    // Only while focus is still the form's or nobody's. A board member who
    // moved on to the aid's yearly total or the register date meanwhile keeps
    // it there, or what they type next would land in the amount field.
    const active = document.activeElement;
    if (
      active !== null &&
      active !== document.body &&
      !formRef.current?.contains(active)
    ) {
      return;
    }
    // The submit button stays disabled after a success, with the amount
    // cleared; the amount field is where the board types next.
    const stillUsable = !target.matches(":disabled");
    (stillUsable ? target : amountRef.current)?.focus();
  }, [recording]);

  const suggestions = useMemo(() => {
    if (!aidOpen || register === null) {
      return null;
    }
    return suggestMonthlyAmounts(yearlyTotal, register.apartments);
  }, [aidOpen, register, yearlyTotal]);

  const suggestedFor = useCallback(
    (id: string): string | null =>
      suggestions?.suggestions.find(
        (suggestion) => suggestion.apartmentId === id,
      )?.monthlyAmount ?? null,
    [suggestions],
  );

  const onRecord = useCallback(
    async (submitter: HTMLElement | null): Promise<void> => {
      setRefusal(null);
      // Said at the field rather than by the request schema, whose refusal
      // can only point at the whole form.
      const amount = normalizeAmount(monthlyAmount);
      const rate = vatTreatment === "RATE" ? vatRateOf(vatRatePercent) : null;
      setAmountInvalid(amount === null);
      setRateInvalid(rate === undefined);
      if (amount === null || rate === undefined) {
        return;
      }
      // Safari and macOS Firefox do not focus a button that was clicked, so the
      // submitter stands in for the focused control when focus is elsewhere.
      const focused = document.activeElement;
      const inForm = (element: Element | null): element is HTMLElement =>
        element instanceof HTMLElement && !!formRef.current?.contains(element);
      focusedBeforeLock.current = inForm(focused)
        ? focused
        : inForm(submitter)
          ? submitter
          : null;
      setRecording(true);
      const result = await recordFee({
        apartmentId,
        kind,
        appliesFrom,
        monthlyAmount: amount,
        vatTreatment,
        vatRatePercent: rate,
      });
      setRecording(false);
      if (!result.ok) {
        setRefusal(feeFailureKey(result.failure));
        return;
      }
      setMonthlyAmount("");
      load();
    },
    [
      apartmentId,
      appliesFrom,
      kind,
      load,
      monthlyAmount,
      vatRatePercent,
      vatTreatment,
    ],
  );

  const onRemove = useCallback(
    async (feeId: string): Promise<void> => {
      setRefusal(null);
      const result = await removeFee(feeId);
      if (!result.ok) {
        setRefusal(feeFailureKey(result.failure));
        return;
      }
      load();
    },
    [load],
  );

  if (forbidden) {
    return <Notice tone="info">{t("fees.forbidden")}</Notice>;
  }

  if (failed && register === null) {
    return <LoadFailure messageKey="fees.loadFailed" onRetry={load} />;
  }

  if (loading && register === null) {
    return (
      <p role="status" className="text-body text-ink-muted">
        {t("fees.loading")}
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      <header className="flex flex-col gap-2 print:hidden">
        <h1 className="text-display">{t("fees.heading")}</h1>
        <p className="text-body text-ink-muted">{t("fees.description")}</p>
        <Notice tone="info">{t("fees.notALedger")}</Notice>
      </header>

      <div className="flex flex-col gap-3 print:hidden">
        {/*
          A read that failed after one had succeeded - the board changed the
          date and the register for it could not be fetched. Said out loud, and
          the document below is withheld while it stands: the register on screen
          would otherwise be the previous day's under a date control naming the
          new one, and the stamp on it would state a day nobody asked for.
        */}
        {failed ? (
          <LoadFailure messageKey="fees.loadFailed" onRetry={load} />
        ) : null}
        {refusal === null ? null : (
          <Notice tone="danger" live>
            {t(refusal)}
          </Notice>
        )}

        <section className={`flex flex-col gap-4 ${PANEL}`}>
          <h2 className="text-title">{t("fees.record.title")}</h2>
          <p className={HINT}>{t("fees.record.description")}</p>
          <form
            ref={formRef}
            className="flex flex-wrap items-end gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              const { submitter } = event.nativeEvent as SubmitEvent;
              void onRecord(submitter);
            }}
          >
            {/*
              Locked while the request runs. The amount is cleared once the
              rate is stored, so what is typed in the meantime would be lost
              without a word. `contents` keeps the fields in the form's own
              flex row.
            */}
            <fieldset className="contents" disabled={recording}>
              <label className={LABEL}>
                {t("fees.record.apartment")}
                <select
                  value={apartmentId}
                  onChange={(event) => {
                    setApartmentId(event.target.value);
                  }}
                  className={FIELD}
                >
                  <option value="">{t("fees.record.chooseApartment")}</option>
                  {(register?.apartments ?? []).map((apartment) => (
                    <option
                      key={apartment.apartmentId}
                      value={apartment.apartmentId}
                    >
                      {apartment.label}
                    </option>
                  ))}
                </select>
              </label>

              <label className={LABEL}>
                {t("fees.record.kind")}
                <select
                  value={kind}
                  onChange={(event) => {
                    setKind(event.target.value as FeeKind);
                  }}
                  className={FIELD}
                >
                  {KINDS.map((value) => (
                    <option key={value} value={value}>
                      {t(KIND_LABEL[value])}
                    </option>
                  ))}
                </select>
              </label>

              <label className={LABEL}>
                {t("fees.record.appliesFrom")}
                <input
                  type="date"
                  value={appliesFrom}
                  onChange={(event) => {
                    setAppliesFrom(event.target.value);
                  }}
                  className={FIELD_DATA}
                />
              </label>

              <div className="flex flex-col gap-1">
                <label className={LABEL}>
                  {t("fees.record.monthlyAmount")}
                  <input
                    ref={amountRef}
                    type="text"
                    inputMode="decimal"
                    value={monthlyAmount}
                    onChange={(event) => {
                      setMonthlyAmount(event.target.value);
                      setAmountInvalid(false);
                    }}
                    aria-invalid={amountInvalid}
                    aria-describedby={amountInvalid ? amountErrorId : undefined}
                    className={FIELD_DATA}
                  />
                </label>
                {amountInvalid ? (
                  <p
                    id={amountErrorId}
                    role="alert"
                    className="text-small text-danger"
                  >
                    {t("fees.errors.amountNotASum")}
                  </p>
                ) : null}
              </div>

              <label className={LABEL}>
                {t("fees.record.vatTreatment")}
                <select
                  value={vatTreatment}
                  onChange={(event) => {
                    setVatTreatment(event.target.value as FeeVatTreatment);
                  }}
                  className={FIELD}
                >
                  {(["EXEMPT", "RATE"] as const).map((value) => (
                    <option key={value} value={value}>
                      {t(VAT_LABEL[value])}
                    </option>
                  ))}
                </select>
              </label>

              {vatTreatment === "RATE" ? (
                <div className="flex flex-col gap-1">
                  <label className={LABEL}>
                    {t("fees.record.vatRatePercent")}
                    <input
                      type="text"
                      inputMode="numeric"
                      value={vatRatePercent}
                      onChange={(event) => {
                        setVatRatePercent(event.target.value);
                        setRateInvalid(false);
                      }}
                      aria-invalid={rateInvalid}
                      aria-describedby={rateInvalid ? rateErrorId : undefined}
                      className={FIELD_DATA}
                    />
                  </label>
                  {rateInvalid ? (
                    <p
                      id={rateErrorId}
                      role="alert"
                      className="text-small text-danger"
                    >
                      {t("fees.errors.vatRateOutOfRange")}
                    </p>
                  ) : null}
                </div>
              ) : null}

              <button
                type="submit"
                className={PRIMARY_BUTTON}
                disabled={apartmentId === "" || monthlyAmount === ""}
              >
                {t("fees.record.submit")}
              </button>
            </fieldset>
          </form>
          <p className={HINT}>{t("fees.record.forwardDated")}</p>
        </section>

        <section className={`flex flex-col gap-4 ${PANEL}`}>
          <h2 className="text-title">{t("fees.aid.title")}</h2>
          <p className={HINT}>{t("fees.aid.description")}</p>
          <Notice tone="warn">{t("fees.aid.notDerived")}</Notice>
          {aidOpen ? (
            <div className="flex flex-wrap items-end gap-3">
              <label className={LABEL}>
                {t("fees.aid.yearlyTotal")}
                <input
                  type="text"
                  inputMode="decimal"
                  value={yearlyTotal}
                  onChange={(event) => {
                    setYearlyTotal(event.target.value);
                  }}
                  className={FIELD_DATA}
                />
              </label>
              <button
                type="button"
                onClick={() => {
                  setAidOpen(false);
                }}
                className={SECONDARY_BUTTON}
              >
                {t("fees.aid.close")}
              </button>
              {suggestions === null ? null : (
                <p className={HINT}>
                  {t("fees.aid.unallocated", {
                    amount: formatAmount(
                      suggestions.unallocated,
                      i18n.language,
                    ),
                  })}
                </p>
              )}
            </div>
          ) : (
            <button
              type="button"
              onClick={() => {
                setAidOpen(true);
              }}
              className={SECONDARY_BUTTON}
            >
              {t("fees.aid.open")}
            </button>
          )}
        </section>

        <FeeNotificationsPanel onRefused={setRefusal} onProduced={setNotices} />

        <AccountingBasisPanel onRefused={setRefusal} />

        <label className={LABEL}>
          {t("fees.on")}
          <input
            type="date"
            value={on}
            onChange={(event) => {
              setOn(event.target.value);
            }}
            className={FIELD_DATA}
          />
        </label>

        <button
          type="button"
          onClick={() => {
            window.print();
          }}
          className={SECONDARY_BUTTON}
        >
          {t("fees.print")}
        </button>
      </div>

      {notices === null ? null : (
        <FeeNoticeDocument
          produced={notices}
          onClose={() => {
            setNotices(null);
          }}
        />
      )}

      {/*
        One document to a printed page: while the notices are open they are
        what prints, and closing them gives the page back to the register.
      */}
      {register === null || failed ? null : (
        <section
          {...DOCUMENT_ATTRIBUTE}
          className={notices === null ? DOCUMENT : `${DOCUMENT} print:hidden`}
        >
          <header className="flex flex-col gap-1">
            <h2 className="text-title">{t("fees.documentTitle")}</h2>
            <p className="font-data text-data text-ink">
              {register.housingCooperative.name}
            </p>
            <p className="text-small text-ink-muted">{t("fees.basisOnly")}</p>
          </header>

          {register.apartments.length === 0 ? (
            <div className="flex flex-col gap-1">
              <p className="text-body text-ink">{t("fees.empty.title")}</p>
              <p className="text-small text-ink-muted">
                {t("fees.empty.description")}
              </p>
            </div>
          ) : (
            <div className={TABLE_SCROLL}>
              <table className={TABLE}>
                <caption className="sr-only">{t("fees.documentTitle")}</caption>
                <thead>
                  <tr>
                    <th scope="col" className={HEAD_CELL}>
                      {t("fees.column.apartment")}
                    </th>
                    <th scope="col" className={HEAD_CELL}>
                      {t("fees.column.participationShare")}
                    </th>
                    <th scope="col" className={HEAD_CELL}>
                      {t("fees.column.kinds")}
                    </th>
                    <th scope="col" className={HEAD_CELL}>
                      {t("fees.column.monthlyAmount")}
                    </th>
                    <th scope="col" className={`${HEAD_CELL} print:hidden`}>
                      {t("fees.column.suggested")}
                    </th>
                    <th scope="col" className={`${HEAD_CELL} print:hidden`}>
                      <span className="sr-only">
                        {t("fees.column.actions")}
                      </span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {register.apartments.map((apartment) => (
                    <tr key={apartment.apartmentId} className={ROW}>
                      <td className={DATA_CELL}>{apartment.label}</td>
                      <td className={DATA_CELL}>
                        {apartment.participationShare ?? (
                          <NotRecorded
                            meaning={t("fees.noValue.participationShare")}
                          />
                        )}
                      </td>
                      <td className={`${CELL} text-body text-ink`}>
                        {apartment.fees.length === 0 ? (
                          <NotRecorded meaning={t("fees.noValue.fees")} />
                        ) : (
                          apartment.fees
                            .map((fee) => t(KIND_LABEL[fee.kind]))
                            .join(", ")
                        )}
                      </td>
                      <td className={DATA_CELL}>
                        {t("fees.amountWithUnit", {
                          amount: formatAmount(
                            apartment.monthlyAmount,
                            i18n.language,
                          ),
                        })}
                      </td>
                      <td className={`${DATA_CELL} print:hidden`}>
                        {suggestedFor(apartment.apartmentId) === null ? (
                          <NotRecorded meaning={t("fees.noValue.suggested")} />
                        ) : (
                          t("fees.amountWithUnit", {
                            amount: formatAmount(
                              suggestedFor(apartment.apartmentId) ?? "",
                              i18n.language,
                            ),
                          })
                        )}
                      </td>
                      <td className={`${CELL} print:hidden`}>
                        {apartment.fees.map((fee) => (
                          <button
                            key={fee.feeId}
                            type="button"
                            onClick={() => {
                              // Confirmed because the rate is deleted for
                              // good: nothing here puts it back.
                              if (
                                window.confirm(
                                  t("fees.removeConfirm", {
                                    kind: t(KIND_LABEL[fee.kind]),
                                    apartment: apartment.label,
                                  }),
                                )
                              ) {
                                void onRemove(fee.feeId);
                              }
                            }}
                            className={QUIET_BUTTON}
                            aria-label={t("fees.removeNamed", {
                              kind: t(KIND_LABEL[fee.kind]),
                              apartment: apartment.label,
                            })}
                          >
                            {t("fees.remove")}
                          </button>
                        ))}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <footer className={STAMP}>
            {t("fees.stamp", {
              date: register.on,
              total: formatAmount(register.monthlyTotal, i18n.language),
            })}
          </footer>
        </section>
      )}
    </div>
  );
}

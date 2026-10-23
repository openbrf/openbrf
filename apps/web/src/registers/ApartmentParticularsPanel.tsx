import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ReactElement } from "react";

import { localDayNow } from "../bookings/booking-calendar";
import {
  FIELD,
  FIELD_DATA,
  HINT,
  LABEL,
  PANEL,
  QUIET_BUTTON,
  SECONDARY_BUTTON,
} from "../ui/controls";
import { decimalFromInput } from "../ui/decimal-input";
import { Notice } from "../ui/Notice";
import {
  type ApartmentParticulars,
  type ApartmentRegisterRow,
  recordApartmentParticulars,
} from "./registers-api";
import {
  CELL,
  DATA_CELL,
  HEAD_CELL,
  ROW,
  TABLE,
  TABLE_SCROLL,
} from "./document";

export interface ApartmentParticularsPanelProps {
  rows: readonly ApartmentRegisterRow[];
  /** The screen's own read, run again once the particulars are stored. */
  onSaved: () => void;
}

/** One apartment's fields as typed, before anything is read out of them. */
interface Draft {
  roomCount: string;
  otherSpaces: string;
  livingArea: string;
  economicPlanRegisteredOn: string;
}

/** The form as it opened: what each apartment read, and what is typed now. */
interface OpenForm {
  opened: Record<string, ApartmentParticulars>;
  draft: Record<string, Draft>;
}

/** The fields as the form shows a reading of them. */
function draftOf(particulars: ApartmentParticulars): Draft {
  return {
    roomCount:
      particulars.roomCount === null ? "" : String(particulars.roomCount),
    otherSpaces: particulars.otherSpaces ?? "",
    livingArea: particulars.livingArea ?? "",
    economicPlanRegisteredOn: particulars.economicPlanRegisteredOn ?? "",
  };
}

function sameDraft(a: Draft, b: Draft): boolean {
  return (
    a.roomCount === b.roomCount &&
    a.otherSpaces === b.otherSpaces &&
    a.livingArea === b.livingArea &&
    a.economicPlanRegisteredOn === b.economicPlanRegisteredOn
  );
}

/**
 * The apartments' particulars: rooms, other spaces, living area and the day the
 * economic plan each was granted under was registered.
 *
 * BRL 9 kap. 10 § forsta stycket 1 and 2 make the apartment register state the
 * first two and the last for every apartment, and 11 § puts them on the
 * holder's extract. The living area is beside them for the broker's description
 * (Fastighetsmaklarlagen 3 kap. 15 § 3).
 *
 * Every apartment at once and closed until it is opened, for the reasons the
 * shares panel gives, and a separate form from that one: these are copied off
 * the economic plan and the upplatelseavtal, the shares off a stadgar annex, and
 * a board correcting one should not be restating the other.
 */
export function ApartmentParticularsPanel({
  rows,
  onSaved,
}: ApartmentParticularsPanelProps): ReactElement {
  const { t } = useTranslation();

  const [form, setForm] = useState<OpenForm | null>(null);
  const [saving, setSaving] = useState(false);
  /*
   * "changed" is its own notice because its remedy is: the board member's
   * entries are fine, and what they need is the values someone else saved.
   */
  const [failure, setFailure] = useState<"invalid" | "changed" | null>(null);
  const draft = form?.draft ?? null;
  // Only the apartments the form opened with, for the reason the shares panel
  // gives.
  const openedRows =
    form === null
      ? []
      : rows.filter((row) => form.opened[row.apartmentId] !== undefined);

  const open = useCallback((): void => {
    setFailure(null);
    const opened = Object.fromEntries(
      rows.map((row): [string, ApartmentParticulars] => [
        row.apartmentId,
        {
          roomCount: row.roomCount,
          otherSpaces: row.otherSpaces,
          livingArea: row.livingArea,
          economicPlanRegisteredOn: row.economicPlanRegisteredOn,
        },
      ]),
    );
    setForm({
      opened,
      draft: Object.fromEntries(
        Object.entries(opened).map(([apartmentId, particulars]) => [
          apartmentId,
          draftOf(particulars),
        ]),
      ),
    });
  }, [rows]);

  const change = useCallback(
    (apartmentId: string, field: keyof Draft, value: string): void => {
      setForm((current) => {
        const entry = current?.draft[apartmentId];
        if (current === null || entry === undefined) {
          return current;
        }
        return {
          ...current,
          draft: {
            ...current.draft,
            [apartmentId]: { ...entry, [field]: value },
          },
        };
      });
    },
    [],
  );

  const submit = useCallback(
    async (element: HTMLFormElement): Promise<void> => {
      if (form === null) {
        return;
      }
      setFailure(null);

      /*
       * A date the browser cannot read - one segment typed, or a day that does
       * not exist - reads as an empty value, and empty is how a board clears the
       * recorded date. Not every browser stops the submission on its own, so the
       * fields are asked here, as they stand now: a field emptied after such an
       * entry fires no change, so a flag kept from the last change could be stale.
       */
      const unreadableDate = Array.from(
        element.querySelectorAll<HTMLInputElement>('input[type="date"]'),
      ).some((input) => input.validity.badInput);

      /*
       * The apartments the form was opened with, and no others, for the reason
       * the shares panel gives: an apartment added by a reload while the form was
       * open would be sent with empty fields, which the server reads as "clear".
       *
       * And of those only the ones the board member changed, each with what it
       * read when the form opened. The server refuses a row whose apartment no
       * longer reads that, so a row nobody touched is left out rather than sent
       * to fail on a colleague's correction it would only have restated.
       */
      const apartments = rows.flatMap((row) => {
        const entry = form.draft[row.apartmentId];
        const expected = form.opened[row.apartmentId];
        if (
          entry === undefined ||
          expected === undefined ||
          sameDraft(entry, draftOf(expected))
        ) {
          return [];
        }
        const rooms = entry.roomCount.trim();
        const area = decimalFromInput(entry.livingArea);
        const spaces = entry.otherSpaces.trim();
        const registered = entry.economicPlanRegisteredOn.trim();
        return [
          {
            apartmentId: row.apartmentId,
            /*
             * Read here rather than sent as typed, because the request carries a
             * number: a count that is not one would travel as NaN, which JSON
             * writes as null - and null clears the recorded count. Left as NaN
             * here, it stops the save below instead.
             */
            roomCount:
              rooms === ""
                ? null
                : /^\d+$/.test(rooms)
                  ? Number(rooms)
                  : Number.NaN,
            otherSpaces: spaces === "" ? null : spaces,
            livingArea: area === "" ? null : area,
            economicPlanRegisteredOn: registered === "" ? null : registered,
            expected,
          },
        ];
      });

      if (
        unreadableDate ||
        apartments.some((apartment) => Number.isNaN(apartment.roomCount))
      ) {
        setFailure("invalid");
        return;
      }

      // Nothing typed, nothing to record: closed as a save would close it.
      if (apartments.length > 0) {
        setSaving(true);
        try {
          const result = await recordApartmentParticulars({ apartments });
          if (!result.ok) {
            setFailure(
              result.failure.reason === "apartment-particulars-changed"
                ? "changed"
                : "invalid",
            );
            return;
          }
        } finally {
          setSaving(false);
        }
      }
      setForm(null);
      onSaved();
    },
    [form, onSaved, rows],
  );

  return (
    <section className={`flex flex-col gap-4 ${PANEL} print:hidden`}>
      <h2 className="text-title">
        {t("registers.apartment.particulars.title")}
      </h2>
      <p className={HINT}>{t("registers.apartment.particulars.description")}</p>

      {failure === null ? null : (
        <Notice tone="danger" live>
          {t(
            failure === "changed"
              ? "registers.apartment.particulars.changed"
              : "registers.apartment.particulars.failed",
          )}
        </Notice>
      )}

      {draft === null ? (
        <button type="button" onClick={open} className={SECONDARY_BUTTON}>
          {t("registers.apartment.particulars.edit")}
        </button>
      ) : (
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            void submit(event.currentTarget);
          }}
        >
          {/*
            The two figures and the date are short and fixed in shape, so their
            columns are narrow and the description of the spaces, which is the
            one field a board writes a sentence into, takes the rest.
          */}
          <div className={TABLE_SCROLL}>
            <table className={TABLE}>
              <caption className="sr-only">
                {t("registers.apartment.particulars.title")}
              </caption>
              <thead>
                <tr>
                  <th scope="col" className={HEAD_CELL}>
                    {t("registers.apartment.particulars.column.apartment")}
                  </th>
                  <th scope="col" className={HEAD_CELL}>
                    {t("registers.apartment.column.roomCount")}
                  </th>
                  <th scope="col" className={HEAD_CELL}>
                    {t("registers.apartment.particulars.column.livingArea")}
                  </th>
                  <th scope="col" className={HEAD_CELL}>
                    {t("registers.apartment.column.otherSpaces")}
                  </th>
                  <th scope="col" className={HEAD_CELL}>
                    {t("registers.apartment.column.economicPlanRegisteredOn")}
                  </th>
                </tr>
              </thead>
              <tbody>
                {openedRows.map((row) => {
                  const entry = draft[row.apartmentId];
                  return (
                    <tr key={row.apartmentId} className={ROW}>
                      <td className={DATA_CELL}>{row.designation}</td>
                      <td className={`${CELL} w-20`}>
                        <label className={LABEL}>
                          <span className="sr-only">
                            {t("registers.apartment.particulars.roomsFor", {
                              apartment: row.designation,
                            })}
                          </span>
                          <input
                            type="text"
                            inputMode="numeric"
                            value={entry?.roomCount ?? ""}
                            maxLength={2}
                            onChange={(event) => {
                              change(
                                row.apartmentId,
                                "roomCount",
                                event.target.value,
                              );
                            }}
                            className={FIELD_DATA}
                          />
                        </label>
                      </td>
                      <td className={`${CELL} w-28`}>
                        <label className={LABEL}>
                          <span className="sr-only">
                            {t("registers.apartment.particulars.areaFor", {
                              apartment: row.designation,
                            })}
                          </span>
                          <input
                            type="text"
                            inputMode="decimal"
                            value={entry?.livingArea ?? ""}
                            maxLength={32}
                            onChange={(event) => {
                              change(
                                row.apartmentId,
                                "livingArea",
                                event.target.value,
                              );
                            }}
                            className={FIELD_DATA}
                          />
                        </label>
                      </td>
                      <td className={CELL}>
                        <label className={LABEL}>
                          <span className="sr-only">
                            {t("registers.apartment.particulars.spacesFor", {
                              apartment: row.designation,
                            })}
                          </span>
                          <input
                            type="text"
                            value={entry?.otherSpaces ?? ""}
                            maxLength={500}
                            onChange={(event) => {
                              change(
                                row.apartmentId,
                                "otherSpaces",
                                event.target.value,
                              );
                            }}
                            className={FIELD}
                          />
                        </label>
                      </td>
                      <td className={`${CELL} w-44`}>
                        <label className={LABEL}>
                          <span className="sr-only">
                            {t("registers.apartment.particulars.planFor", {
                              apartment: row.designation,
                            })}
                          </span>
                          <input
                            type="date"
                            value={entry?.economicPlanRegisteredOn ?? ""}
                            max={localDayNow()}
                            onChange={(event) => {
                              change(
                                row.apartmentId,
                                "economicPlanRegisteredOn",
                                event.target.value,
                              );
                            }}
                            className={FIELD_DATA}
                          />
                        </label>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="flex flex-wrap gap-3">
            <button
              type="submit"
              className={SECONDARY_BUTTON}
              disabled={saving}
            >
              {t("registers.apartment.particulars.submit")}
            </button>
            <button
              type="button"
              disabled={saving}
              onClick={() => {
                setFailure(null);
                setForm(null);
              }}
              className={QUIET_BUTTON}
            >
              {t("registers.apartment.particulars.cancel")}
            </button>
          </div>
        </form>
      )}
    </section>
  );
}

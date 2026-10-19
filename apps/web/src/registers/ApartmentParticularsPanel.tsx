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

  const [draft, setDraft] = useState<Record<string, Draft> | null>(null);
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);

  const open = useCallback((): void => {
    setFailed(false);
    setDraft(
      Object.fromEntries(
        rows.map((row) => [
          row.apartmentId,
          {
            roomCount: row.roomCount === null ? "" : String(row.roomCount),
            otherSpaces: row.otherSpaces ?? "",
            livingArea: row.livingArea ?? "",
            economicPlanRegisteredOn: row.economicPlanRegisteredOn ?? "",
          },
        ]),
      ),
    );
  }, [rows]);

  const change = useCallback(
    (apartmentId: string, field: keyof Draft, value: string): void => {
      setDraft((current) => {
        const entry = current?.[apartmentId];
        if (current === null || entry === undefined) {
          return current;
        }
        return { ...current, [apartmentId]: { ...entry, [field]: value } };
      });
    },
    [],
  );

  const submit = useCallback(async (): Promise<void> => {
    if (draft === null) {
      return;
    }
    setFailed(false);

    /*
     * The apartments the form was opened with, and no others, for the reason
     * the shares panel gives: an apartment added by a reload while the form was
     * open would be sent with empty fields, which the server reads as "clear".
     */
    const apartments = rows.flatMap((row) => {
      const entry = draft[row.apartmentId];
      if (entry === undefined) {
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
        },
      ];
    });

    if (apartments.some((apartment) => Number.isNaN(apartment.roomCount))) {
      setFailed(true);
      return;
    }

    setSaving(true);
    const result = await recordApartmentParticulars({ apartments });
    setSaving(false);
    if (!result.ok) {
      setFailed(true);
      return;
    }
    setDraft(null);
    onSaved();
  }, [draft, onSaved, rows]);

  return (
    <section className={`flex flex-col gap-4 ${PANEL} print:hidden`}>
      <h2 className="text-title">
        {t("registers.apartment.particulars.title")}
      </h2>
      <p className={HINT}>{t("registers.apartment.particulars.description")}</p>

      {failed ? (
        <Notice tone="danger" live>
          {t("registers.apartment.particulars.failed")}
        </Notice>
      ) : null}

      {draft === null ? (
        <button type="button" onClick={open} className={SECONDARY_BUTTON}>
          {t("registers.apartment.particulars.edit")}
        </button>
      ) : (
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
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
                {rows.map((row) => {
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
              onClick={() => {
                setDraft(null);
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

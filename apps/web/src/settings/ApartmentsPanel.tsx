import {
  floorOfApartmentNumber,
  generateApartmentNumbers,
  HIGHEST_FLOOR,
  LOWEST_FLOOR,
  MAX_APARTMENTS_PER_FLOOR,
} from "@openbrf/shared";
import { useCallback, useEffect, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";

import type { AddressView, ApartmentView } from "../api/instance";
import {
  addApartments,
  fetchApartments,
  removeApartment,
} from "../api/instance";
import type { TranslationKey } from "../i18n/translation-key";
import {
  FIELD,
  FIELD_DATA,
  HINT,
  LABEL,
  PRIMARY_BUTTON,
  QUIET_BUTTON,
  SECONDARY_BUTTON,
} from "../ui/controls";
import { Notice } from "../ui/Notice";
import { Panel } from "../ui/Panel";
import { failureMessageKey, useSaveAction } from "../ui/save-state";

export interface ApartmentsPanelProps {
  addresses: readonly AddressView[];
  /** Called after apartments are added or removed, to refresh the counts. */
  onChanged: () => void;
  editable?: boolean;
}

/** One row of the table the board edits before anything is written. */
interface DraftRow {
  /** Stable across edits, so React does not reorder inputs under a cursor. */
  key: number;
  number: string;
}

const APARTMENT_FAILURES: Readonly<Record<string, TranslationKey>> = {
  "apartment-in-use": "settings.apartments.errors.inUse",
  "not-found": "settings.addresses.errors.notFound",
  "invalid-body": "settings.apartments.errors.unknown",
};

/**
 * Describes a floor in words.
 *
 * The number itself already encodes the floor - 10XX is the entrance floor,
 * 11XX the one above - but a four-digit code is not a sentence, and the board
 * grouping in the address book reads "Entreplan" rather than "10". So the words
 * exist alongside the mono number, never instead of it.
 */
function useFloorLabel(): (floor: number | null) => string {
  const { t } = useTranslation();

  return (floor) => {
    if (floor === null) {
      return t("settings.apartments.floor.unknown");
    }
    if (floor === 0) {
      return t("settings.apartments.floor.entrance");
    }
    return floor > 0
      ? t("settings.apartments.floor.above", { floor })
      : t("settings.apartments.floor.below", { floor: Math.abs(floor) });
  };
}

/**
 * Apartments under one address.
 *
 * The generator produces a table and the board edits it before a single row is
 * written. That is what makes a generator acceptable for a statutory register:
 * no real building is perfectly rectangular, so the wizard commits the table
 * rather than the formula. Numbers follow the Lantmateriet convention and are
 * always rendered in the mono face, here and everywhere else.
 */
export function ApartmentsPanel({
  addresses,
  onChanged,
  editable = true,
}: ApartmentsPanelProps): ReactElement {
  const { t } = useTranslation();
  const floorLabel = useFloorLabel();

  /**
   * The address the board picked, if any.
   *
   * The effective id is derived below rather than corrected by an effect: an
   * address list that arrives after the first render, or one whose selected
   * entry has just been removed, would otherwise leave the select pointing at
   * nothing until a second render fixed it.
   */
  const [chosenId, setChosenId] = useState<string | null>(null);
  const addressId =
    chosenId !== null && addresses.some((address) => address.id === chosenId)
      ? chosenId
      : (addresses[0]?.id ?? "");

  const [existing, setExisting] = useState<readonly ApartmentView[]>([]);
  const [rows, setRows] = useState<readonly DraftRow[]>([]);
  const [nextKey, setNextKey] = useState(1);
  const [lowestFloor, setLowestFloor] = useState("0");
  const [floorCount, setFloorCount] = useState("3");
  const [perFloor, setPerFloor] = useState("4");

  const read = useCallback(async (): Promise<readonly ApartmentView[]> => {
    if (addressId === "") {
      return [];
    }
    const result = await fetchApartments(addressId);
    return result.ok ? result.value : [];
  }, [addressId]);

  useEffect(() => {
    // Guarded so a response for an address the board has already navigated away
    // from cannot overwrite the list for the one they are looking at.
    let active = true;
    void read().then((rows) => {
      if (active) {
        setExisting(rows);
      }
    });
    return () => {
      active = false;
    };
  }, [read]);

  const reload = (): void => {
    void read().then(setExisting);
  };

  /** Counts from the last commit, so the panel can say what actually landed. */
  const [committed, setCommitted] = useState<{
    created: number;
    skipped: number;
  } | null>(null);

  const commit = useSaveAction(addApartments, (result) => {
    setRows([]);
    setCommitted(result);
    reload();
    onChanged();
  });
  const remove = useSaveAction(removeApartment, () => {
    reload();
    onChanged();
  });

  const failure =
    commit.state.kind === "failed"
      ? commit.state.failure
      : remove.state.kind === "failed"
        ? remove.state.failure
        : null;

  const generate = (): void => {
    const generated = generateApartmentNumbers({
      lowestFloor: clamp(lowestFloor, LOWEST_FLOOR, HIGHEST_FLOOR, 0),
      floorCount: clamp(floorCount, 0, HIGHEST_FLOOR - LOWEST_FLOOR + 1, 1),
      apartmentsPerFloor: clamp(perFloor, 1, MAX_APARTMENTS_PER_FLOOR, 1),
    });

    setRows(
      generated.map((row, index) => ({
        key: nextKey + index,
        number: row.number,
      })),
    );
    setNextKey(nextKey + generated.length);
  };

  const addRow = (): void => {
    setRows([...rows, { key: nextKey, number: "" }]);
    setNextKey(nextKey + 1);
  };

  const filled = rows.filter((row) => row.number.trim() !== "");
  const duplicate = firstDuplicate(filled.map((row) => row.number.trim()));

  return (
    <Panel
      title={t("settings.apartments.title")}
      description={t("settings.apartments.description")}
      notice={
        failure !== null ? (
          <Notice tone="danger" live>
            {t(
              failureMessageKey(
                failure,
                APARTMENT_FAILURES,
                "settings.apartments.errors.unknown",
              ),
            )}
          </Notice>
        ) : commit.state.kind === "saved" && committed !== null ? (
          <Notice tone="ok" live>
            {/* The skipped count matters: the API adds each number once, so a
                table committed twice reports the second attempt honestly rather
                than claiming to have added everything again. */}
            {t("settings.apartments.committed", {
              created: committed.created,
              skipped: committed.skipped,
            })}
          </Notice>
        ) : duplicate !== null ? (
          <Notice tone="warn" live>
            {t("settings.apartments.duplicateNumber", { number: duplicate })}
          </Notice>
        ) : null
      }
    >
      {addresses.length === 0 ? (
        <p className="text-body text-ink-muted">
          {t("settings.addresses.none")}
        </p>
      ) : (
        <>
          <label className={LABEL}>
            {t("settings.apartments.selectAddress")}
            <select
              name="apartmentsAddress"
              value={addressId}
              onChange={(event) => {
                setChosenId(event.target.value);
                setRows([]);
              }}
              className={FIELD}
            >
              {addresses.map((address) => (
                <option key={address.id} value={address.id}>
                  {`${address.street} ${address.number}`}
                </option>
              ))}
            </select>
          </label>

          <section className="flex flex-col gap-3">
            <h3 className="text-label text-ink-muted uppercase">
              {t("settings.apartments.registered")}
            </h3>
            {existing.length === 0 ? (
              <p className="text-small text-ink-muted">
                {t("settings.apartments.none")}
              </p>
            ) : (
              <ul className="flex flex-wrap gap-2">
                {existing.map((apartment) => (
                  <li
                    key={apartment.id}
                    className="flex items-center gap-2 rounded-control border border-line bg-page px-2 py-1.5"
                  >
                    <span className="font-data text-data">
                      {apartment.number}
                    </span>
                    <span className="text-chip text-ink-muted uppercase">
                      {floorLabel(apartment.floor)}
                    </span>
                    {editable ? (
                      <button
                        type="button"
                        aria-label={t("settings.apartments.removeRow")}
                        disabled={remove.state.kind === "saving"}
                        onClick={() => {
                          void remove.submit(apartment.id);
                        }}
                        className="min-h-11 px-1 text-small text-ink-muted underline"
                      >
                        {t("settings.addresses.remove")}
                      </button>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </section>

          {editable ? (
            <>
              <section className="flex flex-col gap-3 border-t border-line pt-4">
                <h3 className="text-label text-ink-muted uppercase">
                  {t("settings.apartments.generator.title")}
                </h3>
                <p className={HINT}>
                  {t("settings.apartments.generator.description")}
                </p>

                <div className="grid gap-4 sm:grid-cols-3">
                  <label className={LABEL}>
                    {t("settings.apartments.generator.lowestFloor")}
                    <input
                      type="number"
                      name="lowestFloor"
                      min={LOWEST_FLOOR}
                      max={HIGHEST_FLOOR}
                      value={lowestFloor}
                      onChange={(event) => {
                        setLowestFloor(event.target.value);
                      }}
                      className={FIELD_DATA}
                    />
                    <span className={HINT}>
                      {t("settings.apartments.generator.lowestFloorHint")}
                    </span>
                  </label>

                  <label className={LABEL}>
                    {t("settings.apartments.generator.floorCount")}
                    <input
                      type="number"
                      name="floorCount"
                      min={1}
                      max={HIGHEST_FLOOR - LOWEST_FLOOR + 1}
                      value={floorCount}
                      onChange={(event) => {
                        setFloorCount(event.target.value);
                      }}
                      className={FIELD_DATA}
                    />
                  </label>

                  <label className={LABEL}>
                    {t("settings.apartments.generator.apartmentsPerFloor")}
                    <input
                      type="number"
                      name="apartmentsPerFloor"
                      min={1}
                      max={MAX_APARTMENTS_PER_FLOOR}
                      value={perFloor}
                      onChange={(event) => {
                        setPerFloor(event.target.value);
                      }}
                      className={FIELD_DATA}
                    />
                  </label>
                </div>

                <div className="flex flex-wrap gap-3">
                  <button
                    type="button"
                    onClick={generate}
                    className={SECONDARY_BUTTON}
                  >
                    {t("settings.apartments.generator.generate")}
                  </button>
                  <button
                    type="button"
                    onClick={addRow}
                    className={QUIET_BUTTON}
                  >
                    {t("settings.apartments.addRow")}
                  </button>
                </div>
              </section>

              {rows.length === 0 ? (
                <p className={HINT}>{t("settings.apartments.draftEmpty")}</p>
              ) : (
                <div className="flex flex-col gap-3">
                  {/* The table scrolls inside its own box: the page itself must
                      never scroll sideways. */}
                  <div className="overflow-x-auto">
                    <table className="w-full min-w-md border-collapse">
                      <thead>
                        <tr className="border-b border-line-strong">
                          <th className="py-2 pr-3 text-left text-label text-ink-muted uppercase">
                            {t("settings.apartments.table.number")}
                          </th>
                          <th className="py-2 pr-3 text-left text-label text-ink-muted uppercase">
                            {t("settings.apartments.table.floor")}
                          </th>
                          <th className="py-2 text-right text-label text-ink-muted uppercase">
                            {t("settings.apartments.table.action")}
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {rows.map((row) => (
                          <tr key={row.key} className="border-b border-line">
                            <td className="py-1.5 pr-3">
                              <input
                                type="text"
                                aria-label={t(
                                  "settings.apartments.table.number",
                                )}
                                value={row.number}
                                onChange={(event) => {
                                  setRows(
                                    rows.map((candidate) =>
                                      candidate.key === row.key
                                        ? {
                                            ...candidate,
                                            number: event.target.value,
                                          }
                                        : candidate,
                                    ),
                                  );
                                }}
                                className={FIELD_DATA}
                              />
                            </td>
                            <td className="py-1.5 pr-3 font-data text-data text-ink-muted">
                              {floorLabel(
                                floorOfApartmentNumber(row.number.trim()),
                              )}
                            </td>
                            <td className="py-1.5 text-right">
                              <button
                                type="button"
                                aria-label={t("settings.apartments.removeRow")}
                                onClick={() => {
                                  setRows(
                                    rows.filter(
                                      (candidate) => candidate.key !== row.key,
                                    ),
                                  );
                                }}
                                className={QUIET_BUTTON}
                              >
                                {t("settings.addresses.remove")}
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>

                  <div>
                    <button
                      type="button"
                      disabled={
                        filled.length === 0 ||
                        duplicate !== null ||
                        commit.state.kind === "saving"
                      }
                      onClick={() => {
                        void commit.submit(
                          addressId,
                          filled.map((row) => ({ number: row.number.trim() })),
                        );
                      }}
                      className={PRIMARY_BUTTON}
                    >
                      {commit.state.kind === "saving"
                        ? t("settings.saving")
                        : t("settings.apartments.commit")}
                    </button>
                  </div>
                </div>
              )}
            </>
          ) : null}
        </>
      )}
    </Panel>
  );
}

/** Reads a numeric field, falling back rather than producing NaN. */
function clamp(
  raw: string,
  minimum: number,
  maximum: number,
  fallback: number,
): number {
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed)) {
    return fallback;
  }
  return Math.min(Math.max(parsed, minimum), maximum);
}

/**
 * The first number that appears twice, or null.
 *
 * Caught in the browser because the API skips duplicates silently: two rows
 * with the same number would produce one apartment and no complaint, and the
 * board would be left believing they had added both.
 */
function firstDuplicate(numbers: readonly string[]): string | null {
  const seen = new Set<string>();
  for (const number of numbers) {
    if (seen.has(number)) {
      return number;
    }
    seen.add(number);
  }
  return null;
}

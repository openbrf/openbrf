import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ReactElement } from "react";

import {
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
  type ApartmentShares,
  recordApartmentShares,
} from "./registers-api";
import {
  CELL,
  DATA_CELL,
  HEAD_CELL,
  ROW,
  TABLE,
  TABLE_SCROLL,
} from "./document";

export interface ApartmentSharesPanelProps {
  rows: readonly ApartmentRegisterRow[];
  /** The screen's own read, run again once the figures are stored. */
  onSaved: () => void;
  /**
   * The screen's own read, run again when a save is refused because someone
   * else saved first. Says whether the read answered, which decides whether
   * the notice can promise the register below shows the current figures.
   */
  onRefresh: () => Promise<boolean>;
}

/** One apartment's figures as typed, before anything is read out of them. */
interface Draft {
  participationShare: string;
  initialShareCapital: string;
}

/** The form as it opened: what each apartment read, and what is typed now. */
interface OpenForm {
  opened: Record<string, ApartmentShares>;
  draft: Record<string, Draft>;
}

const NOTICE_KEY = {
  invalid: "registers.apartment.shares.failed",
  changed: "registers.apartment.shares.changed",
  "changed-unread": "registers.apartment.shares.changedUnread",
} as const;

/** The fields as the form shows a reading of them. */
function draftOf(shares: ApartmentShares): Draft {
  return {
    participationShare: shares.participationShare ?? "",
    initialShareCapital: shares.initialShareCapital ?? "",
  };
}

/**
 * The apartments' participation shares and initial share capitals (andelstal
 * och insatser).
 *
 * Every apartment at once, because a board types eighty of them in one sitting
 * or none: the figures come off a stadgar annex or a spreadsheet the economic
 * manager sent, and a panel that took them one at a time would be eighty round
 * trips and eighty chances to stop halfway.
 *
 * ## Recorded and never applied
 *
 * The register holds both figures and nothing in this platform derives a fee
 * from either. The word andelstal occurs nowhere in bostadsrattslagen: BRL
 * 9 kap. 5 § forsta stycket 5 makes the basis for calculating the arsavgift a
 * matter for the stadgar, and 9 kap. 13 § makes fixing the avgifter the board's
 * own task. The fee screen offers the share as an aid the board accepts or
 * overwrites, and what is stored there is the amount the board stated.
 *
 * ## The insats stays in this register
 *
 * It is statutory tier and confidential to the apartment register, which is why
 * the panel is here rather than in the settings or on the fee screen, and why
 * it is behind the register's own capability.
 *
 * ## Closed until it is opened
 *
 * The panel is a button until somebody clicks it, like the property designation
 * and land tenure writes above it. A form of eighty pairs of fields standing
 * open on a document screen would be the first thing a board member met, and
 * the screen's job is the register rather than this one act.
 */
export function ApartmentSharesPanel({
  rows,
  onSaved,
  onRefresh,
}: ApartmentSharesPanelProps): ReactElement {
  const { t } = useTranslation();

  const [form, setForm] = useState<OpenForm | null>(null);
  const [saving, setSaving] = useState(false);
  /*
   * "changed" is its own notice because its remedy is: the board member's
   * figures are fine, and what they need is the ones someone else saved.
   * "changed-unread" is the same refusal when the register could not be read
   * again, so reopening the form would only snapshot the figures it already
   * holds: the remedy there is to reload the page.
   */
  const [failure, setFailure] = useState<
    "invalid" | "changed" | "changed-unread" | null
  >(null);
  const draft = form?.draft ?? null;
  /*
   * The register in its current order, but only the apartments the form opened
   * with. A refused save reads the register again while the form stays open,
   * and an apartment added since would otherwise get a field that ignores
   * every keystroke, since the draft has no entry for it.
   */
  const openedRows =
    form === null
      ? []
      : rows.filter((row) => form.opened[row.apartmentId] !== undefined);

  const open = useCallback((): void => {
    setFailure(null);
    const opened = Object.fromEntries(
      rows.map((row): [string, ApartmentShares] => [
        row.apartmentId,
        {
          participationShare: row.participationShare,
          initialShareCapital: row.initialShareCapital,
        },
      ]),
    );
    setForm({
      opened,
      draft: Object.fromEntries(
        Object.entries(opened).map(([apartmentId, shares]) => [
          apartmentId,
          draftOf(shares),
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

  const submit = useCallback(async (): Promise<void> => {
    if (form === null) {
      return;
    }
    setFailure(null);

    /*
     * The apartments the form was opened with, and no others. `rows` is the
     * register as it stands now, and a reload while the form was open can have
     * added an apartment the form shows no field for. Sending it would send
     * two empty fields, which the server reads as "clear" - and an apartment's
     * recorded figures would be erased from a confidential statutory register
     * by a save nobody aimed at it.
     *
     * And of those only the ones the board member changed, each with what it
     * read when the form opened. The server refuses a row whose apartment no
     * longer reads that, so a row nobody touched is left out rather than sent
     * to fail on a colleague's correction it would only have restated.
     */
    const apartments = rows.flatMap((row) => {
      const entry = form.draft[row.apartmentId];
      const expected = form.opened[row.apartmentId];
      if (expected === undefined || entry === undefined) {
        return [];
      }
      const unchanged = draftOf(expected);
      if (
        entry.participationShare === unchanged.participationShare &&
        entry.initialShareCapital === unchanged.initialShareCapital
      ) {
        return [];
      }
      const share = decimalFromInput(entry.participationShare);
      const capital = decimalFromInput(entry.initialShareCapital);
      return [
        {
          apartmentId: row.apartmentId,
          // Cleared rather than stored empty: the register states a figure or
          // says none is recorded, and an empty string is neither.
          participationShare: share === "" ? null : share,
          initialShareCapital: capital === "" ? null : capital,
          expected,
        },
      ];
    });

    // Nothing typed, nothing to record: closed as a save would close it.
    if (apartments.length > 0) {
      setSaving(true);
      try {
        const result = await recordApartmentShares({ apartments });
        if (!result.ok) {
          if (result.failure.reason === "apartment-shares-changed") {
            /*
             * Read the register again before saying anything: the form
             * snapshots `rows` when it opens, so a reader who followed the
             * notice and reopened it without this would see the figures they
             * already have and send the same expected pair into another
             * refusal. What was typed stays until the reader cancels.
             */
            const read = await onRefresh();
            setFailure(read ? "changed" : "changed-unread");
          } else {
            setFailure("invalid");
          }
          return;
        }
      } finally {
        setSaving(false);
      }
    }
    setForm(null);
    onSaved();
  }, [form, onRefresh, onSaved, rows]);

  return (
    <section className={`flex flex-col gap-4 ${PANEL} print:hidden`}>
      <h2 className="text-title">{t("registers.apartment.shares.title")}</h2>
      <p className={HINT}>{t("registers.apartment.shares.description")}</p>
      <Notice tone="info">{t("registers.apartment.shares.notDerived")}</Notice>

      {failure === null ? null : (
        <Notice tone="danger" live>
          {t(NOTICE_KEY[failure])}
        </Notice>
      )}

      {draft === null ? (
        <button type="button" onClick={open} className={SECONDARY_BUTTON}>
          {t("registers.apartment.shares.edit")}
        </button>
      ) : (
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <div className={TABLE_SCROLL}>
            <table className={TABLE}>
              <caption className="sr-only">
                {t("registers.apartment.shares.title")}
              </caption>
              <thead>
                <tr>
                  <th scope="col" className={HEAD_CELL}>
                    {t("registers.apartment.shares.column.apartment")}
                  </th>
                  <th scope="col" className={HEAD_CELL}>
                    {t("registers.apartment.column.participationShare")}
                  </th>
                  <th scope="col" className={HEAD_CELL}>
                    {t("registers.apartment.column.initialShareCapital")}
                  </th>
                </tr>
              </thead>
              <tbody>
                {openedRows.map((row) => (
                  <tr key={row.apartmentId} className={ROW}>
                    <td className={DATA_CELL}>{row.designation}</td>
                    <td className={CELL}>
                      <label className={LABEL}>
                        <span className="sr-only">
                          {t("registers.apartment.shares.shareFor", {
                            apartment: row.designation,
                          })}
                        </span>
                        <input
                          type="text"
                          inputMode="decimal"
                          value={
                            draft[row.apartmentId]?.participationShare ?? ""
                          }
                          maxLength={32}
                          onChange={(event) => {
                            change(
                              row.apartmentId,
                              "participationShare",
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
                          {t("registers.apartment.shares.capitalFor", {
                            apartment: row.designation,
                          })}
                        </span>
                        <input
                          type="text"
                          inputMode="decimal"
                          value={
                            draft[row.apartmentId]?.initialShareCapital ?? ""
                          }
                          maxLength={32}
                          onChange={(event) => {
                            change(
                              row.apartmentId,
                              "initialShareCapital",
                              event.target.value,
                            );
                          }}
                          className={FIELD_DATA}
                        />
                      </label>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="flex flex-wrap gap-3">
            <button
              type="submit"
              className={SECONDARY_BUTTON}
              disabled={saving}
            >
              {t("registers.apartment.shares.submit")}
            </button>
            <button
              type="button"
              onClick={() => {
                setFailure(null);
                setForm(null);
              }}
              className={QUIET_BUTTON}
            >
              {t("registers.apartment.shares.cancel")}
            </button>
          </div>
        </form>
      )}
    </section>
  );
}

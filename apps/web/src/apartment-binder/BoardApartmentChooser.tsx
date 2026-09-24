import { useId } from "react";
import { useTranslation } from "react-i18next";
import type { ReactElement } from "react";

import { FIELD_DATA, HINT, LABEL } from "../ui/controls";
import type { BoardBinderSummary } from "./apartment-binder-api";

/**
 * The apartment whose binder the board is reading.
 *
 * One control rather than a list of every apartment, because a cooperative has
 * forty of them and the board is looking for one door. The designations arrive
 * in the register's own order - by street, by number, by apartment - so the
 * list reads the way the building does without this deciding an order of its
 * own.
 *
 * In the data face, because an apartment designation is data: a column of them
 * aligns character for character, which is what makes 1201 and 1210 tell
 * themselves apart at a glance.
 *
 * Nothing is chosen to begin with. Choosing is what reads a household's papers
 * and puts an entry in the audit log, so the screen does not do it on somebody's
 * behalf - and an apartment picked by the interface would be a board member
 * recorded reading a binder they never asked for.
 */
export interface BoardApartmentChooserProps {
  binders: readonly BoardBinderSummary[];
  /** The apartment chosen, or "" while none is. */
  chosen: string;
  onChoose: (apartmentId: string) => void;
}

export function BoardApartmentChooser({
  binders,
  chosen,
  onChoose,
}: BoardApartmentChooserProps): ReactElement {
  const { t } = useTranslation();
  const fieldId = useId();

  return (
    <div className="flex flex-col gap-1.5">
      <label className={LABEL} htmlFor={`${fieldId}-apartment`}>
        {t("apartmentBinder.board.chooser")}
        <select
          id={`${fieldId}-apartment`}
          value={chosen}
          onChange={(event) => {
            onChoose(event.target.value);
          }}
          className={`${FIELD_DATA} max-w-96`}
        >
          <option value="">{t("apartmentBinder.board.choose")}</option>
          {binders.map((binder) => (
            <option key={binder.apartmentId} value={binder.apartmentId}>
              {t("apartmentBinder.board.apartmentOption", {
                apartment: binder.apartment,
                entries: t("apartmentBinder.board.entries", {
                  count: binder.entries,
                }),
              })}
            </option>
          ))}
        </select>
      </label>
      {/*
       * Under the control rather than inside its label: a label carries the
       * board's own lettering, which is uppercase, and a sentence set in it
       * reads as a sign rather than as help. The same placement the subletting
       * and key order forms use.
       */}
      <p className={HINT}>{t("apartmentBinder.board.chooserHint")}</p>
    </div>
  );
}

import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";

import type { IssuePlaceCount } from "../api/issues";
import { HINT, QUIET_BUTTON, SECONDARY_BUTTON } from "../ui/controls";
import { Panel } from "../ui/Panel";

export interface IssuePlaceCountsPanelProps {
  places: readonly IssuePlaceCount[];
  /** The place the queue is narrowed to, or "" for all. */
  selected: string;
  onSelect: (placeId: string) => void;
}

/**
 * How many issues each common-area place has (decision 30), which is what makes
 * a repeat fault visible: three faults in the lift read as one trouble, not as
 * three unrelated reports. Counts what this handler may open, closed issues
 * included, because the place outlives the free text. Choosing one narrows the
 * queue to it.
 *
 * Offers nothing while the association keeps no places.
 */
export function IssuePlaceCountsPanel({
  places,
  selected,
  onSelect,
}: IssuePlaceCountsPanelProps): ReactElement | null {
  const { t } = useTranslation();
  if (places.length === 0) {
    return null;
  }
  return (
    <Panel
      title={t("issues.places.title")}
      description={t("issues.places.description")}
    >
      <ul className="flex flex-col gap-1">
        {places.map((place) => (
          <li
            key={place.id}
            className="flex flex-wrap items-center gap-x-4 gap-y-1"
          >
            <span className="min-w-40 text-body font-semibold">
              {place.name}
            </span>
            <span className="font-data text-data">
              {t("issues.places.counts", {
                issues: place.issues,
                open: place.open,
              })}
            </span>
            {place.issues === 0 && selected !== place.id ? null : (
              <button
                type="button"
                aria-pressed={selected === place.id}
                className={
                  selected === place.id ? SECONDARY_BUTTON : QUIET_BUTTON
                }
                onClick={() => {
                  onSelect(selected === place.id ? "" : place.id);
                }}
              >
                {selected === place.id
                  ? t("issues.places.showAll")
                  : t("issues.places.showOnly", { place: place.name })}
              </button>
            )}
          </li>
        ))}
      </ul>
      <p className={`${HINT} pt-2`}>{t("issues.places.hint")}</p>
    </Panel>
  );
}

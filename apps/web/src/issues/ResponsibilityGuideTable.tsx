import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";

import type { ResponsibilityGuide } from "../api/issues";
import { HINT } from "../ui/controls";
import { MAINTENANCE_RESPONSIBILITY_LABEL } from "./issue-labels";

/**
 * The association's responsibility guide (ansvarsfördelning), read-only: who
 * maintains which part of the home and the building, as the board reads its
 * own bylaws (decision 27 of the issue module plan).
 *
 * Always with the sentence that says what it is. An adopted guide is the
 * board's reading of its bylaws, and the bylaws come first. A guide the board
 * has not adopted is an example, and says so above the table rather than in
 * small print under it: BRL 7 kap. 12 § lets each association's bylaws move
 * the line, so the example is never an answer about this association.
 *
 * The caller decides who sees which. A handler sees the guide either way; a
 * reporter is only ever handed an adopted one, by the server.
 */
export function ResponsibilityGuideTable({
  guide,
  caption,
}: {
  guide: ResponsibilityGuide;
  /** What the table is called, for a reader moving by tables. */
  caption: string;
}): ReactElement {
  const { t } = useTranslation();
  const isExample = guide.adoptedAt === null;

  return (
    <div className="flex flex-col gap-2">
      <p className={isExample ? "text-small font-semibold text-ink" : HINT}>
        {isExample ? t("issues.guide.example") : t("issues.guide.adopted")}
      </p>
      {guide.items.length === 0 ? (
        <p className={HINT}>{t("issues.guide.empty")}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-small">
            <caption className="sr-only">{caption}</caption>
            <thead>
              <tr className="border-b border-line">
                <th scope="col" className="py-1 pe-3 font-semibold">
                  {t("issues.guide.part")}
                </th>
                <th scope="col" className="py-1 pe-3 font-semibold">
                  {t("issues.guide.responsibility")}
                </th>
                <th scope="col" className="py-1 font-semibold">
                  {t("issues.guide.note")}
                </th>
              </tr>
            </thead>
            <tbody>
              {guide.items.map((item, index) => (
                <tr
                  // The lines carry no identifier on the wire, and the guide
                  // is read whole and replaced whole.
                  key={`${String(index)}:${item.part}`}
                  className="border-b border-line align-top"
                >
                  <td className="py-1 pe-3">{item.part}</td>
                  <td className="py-1 pe-3">
                    {t(MAINTENANCE_RESPONSIBILITY_LABEL[item.responsibility])}
                  </td>
                  <td className="py-1 text-ink-muted">{item.note ?? ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

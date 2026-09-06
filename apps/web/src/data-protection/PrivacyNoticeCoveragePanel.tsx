import { type ReactElement } from "react";
import { useTranslation } from "react-i18next";

import {
  appendPrivacyNoticeHeadings,
  type PrivacyNoticeCoverage,
} from "../api/data-protection";
import { HINT, SECONDARY_BUTTON } from "../ui/controls";
import { Notice } from "../ui/Notice";
import { Panel } from "../ui/Panel";
import { useSaveAction } from "../ui/save-state";

export interface PrivacyNoticeCoveragePanelProps {
  coverage: PrivacyNoticeCoverage;
  onAppended: (coverage: PrivacyNoticeCoverage) => void;
}

/**
 * Whether the privacy notice answers everything GDPR art. 13 requires.
 *
 * The panel names the questions rather than scoring the page. A board reading
 * "11 of 15" learns that something is missing; a board reading which headings
 * are absent knows what to write this evening.
 *
 * The button appends headings and never text. That boundary is stated on the
 * screen, not only in the code, because it is the difference between a product
 * that helps a board write its own notice and one that writes the notice for
 * it - and the board is legally answerable for every word of it.
 */
export function PrivacyNoticeCoveragePanel({
  coverage,
  onAppended,
}: PrivacyNoticeCoveragePanelProps): ReactElement {
  const { t } = useTranslation();
  const append = useSaveAction(appendPrivacyNoticeHeadings, onAppended);

  const missing = coverage.sections.filter((section) => !section.present);
  const nothingToAdd = missing.length === 0 && coverage.controllerContactBlock;

  return (
    <Panel
      title={t("dataProtection.coverage.title")}
      description={t("dataProtection.coverage.description")}
    >
      {!coverage.exists ? (
        <Notice tone="warn">
          {t("dataProtection.coverage.noticeMissing")}
        </Notice>
      ) : (
        <>
          {!coverage.published ? (
            <Notice tone="warn">
              {t("dataProtection.coverage.unpublished")}
            </Notice>
          ) : null}

          <ul className="flex flex-col gap-1">
            {coverage.sections.map((section) => (
              <li key={section.section} className="flex gap-2 text-small">
                {/*
                 * A word rather than a tick or a colour. DESIGN.md requires a
                 * second signal beside colour, and here the word is the only
                 * signal there needs to be.
                 */}
                <span className="font-semibold">
                  {section.present
                    ? t("dataProtection.coverage.present")
                    : t("dataProtection.coverage.absent")}
                </span>
                <span>
                  {t(`site.privacyNotice.sections.${section.section}`)}
                </span>
              </li>
            ))}
          </ul>

          <p className={HINT}>{t("dataProtection.coverage.appendBoundary")}</p>

          <div>
            <button
              type="button"
              className={SECONDARY_BUTTON}
              disabled={nothingToAdd || append.state.kind === "saving"}
              onClick={() => {
                void append.submit();
              }}
            >
              {append.state.kind === "saving"
                ? t("dataProtection.coverage.appending")
                : t("dataProtection.coverage.append")}
            </button>
          </div>

          {append.state.kind === "failed" ? (
            <Notice tone="danger" live>
              {t("dataProtection.coverage.appendFailed")}
            </Notice>
          ) : null}
        </>
      )}
    </Panel>
  );
}

import { useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";

import { saveIssueReporting } from "../api/issues";
import { Notice } from "../ui/Notice";
import { Panel } from "../ui/Panel";
import { failureMessageKey, useSaveAction } from "../ui/save-state";

export interface IssueReportingPanelProps {
  publicFormEnabled: boolean;
  onSaved?: (value: { publicFormEnabled: boolean }) => void;
  editable?: boolean;
}

/**
 * Whether the association's website carries an issue report form.
 *
 * On by default, which is the opposite of the sign-up form beside it, and the
 * difference is what the two produce: a sign-up request asks for an account on
 * an instance holding a statutory register, while an issue report produces a
 * maintenance ticket. The state is written out in words underneath for the same
 * reason the other switch does it - this decides whether a form anyone can
 * reach exists at all, and a board member must be able to read what it is
 * currently doing rather than interpret the position of a control.
 */
export function IssueReportingPanel({
  publicFormEnabled,
  onSaved,
  editable = true,
}: IssueReportingPanelProps): ReactElement {
  const { t } = useTranslation();

  /*
   * What the server says, unless this panel has itself set something. Null
   * means "nothing of our own": the prop stands, so a parent that reloads the
   * settings can correct this panel.
   */
  const [attempted, setAttempted] = useState<boolean | null>(null);
  const on = attempted ?? publicFormEnabled;

  const save = useSaveAction(saveIssueReporting, (value) => {
    setAttempted(value.publicFormEnabled);
    onSaved?.(value);
  });

  return (
    <Panel
      title={t("settings.issueReporting.title")}
      description={t("settings.issueReporting.description")}
      notice={
        save.state.kind === "failed" ? (
          <Notice tone="danger" live>
            {t(
              failureMessageKey(
                save.state.failure,
                {},
                "settings.errors.unknown",
              ),
            )}
          </Notice>
        ) : null
      }
    >
      <label className="flex min-h-11 items-center gap-3 text-body">
        <input
          type="checkbox"
          name="issueReportingPublic"
          checked={on}
          disabled={!editable || save.state.kind === "saving"}
          onChange={(event) => {
            const next = event.target.checked;
            setAttempted(next);
            void save.submit({ publicFormEnabled: next }).then((saved) => {
              /*
               * Dropped on a refusal, so the server's value stands again. The
               * dangerous direction is closing: a board that unticks the box,
               * sees "off" and walks away has been told a public form is gone
               * while it is still on the association's website.
               */
              if (!saved) {
                setAttempted(null);
              }
            });
          }}
          className="size-4"
        />
        {t("settings.issueReporting.enabled")}
      </label>

      {/* The state in words. A checkbox alone is a shape, and this decides
          whether a public form exists. */}
      <p className="text-small text-ink-muted">
        {on
          ? t("settings.issueReporting.stateOn")
          : t("settings.issueReporting.stateOff")}
      </p>
    </Panel>
  );
}

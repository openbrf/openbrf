import { useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";

import { saveSelfSignup } from "../api/instance";
import { Notice } from "../ui/Notice";
import { Panel } from "../ui/Panel";
import { failureMessageKey, useSaveAction } from "../ui/save-state";

export interface SelfSignupPanelProps {
  enabled: boolean;
  onSaved?: (value: { enabled: boolean }) => void;
  editable?: boolean;
}

/**
 * Whether the instance accepts sign-up requests.
 *
 * Off by default, and the state is written out in words underneath rather than
 * left to the position of a control: this switch decides whether a form that
 * anyone can reach exists at all on an instance holding a statutory register,
 * so a board member must be able to read what it is currently doing without
 * interpreting a toggle.
 *
 * Approving a request is still a human act. Nothing is created until a board
 * member matches the claim to a real apartment.
 */
export function SelfSignupPanel({
  enabled,
  onSaved,
  editable = true,
}: SelfSignupPanelProps): ReactElement {
  const { t } = useTranslation();

  /*
   * What the server says, unless this panel has itself set something.
   *
   * Derived rather than seeded into state once. The server is the authority on
   * whether a public sign-up form exists, so a parent that reloads the settings
   * has to be able to correct this panel - and a seed captured on the first
   * render would ignore it. Null means "nothing of our own": the prop stands.
   */
  const [attempted, setAttempted] = useState<boolean | null>(null);
  const on = attempted ?? enabled;

  const save = useSaveAction(saveSelfSignup, (value) => {
    setAttempted(value.enabled);
    onSaved?.(value);
  });

  return (
    <Panel
      title={t("settings.selfSignup.title")}
      description={t("settings.selfSignup.description")}
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
          name="selfSignupEnabled"
          checked={on}
          disabled={!editable || save.state.kind === "saving"}
          onChange={(event) => {
            const next = event.target.checked;
            setAttempted(next);
            void save.submit({ enabled: next }).then((saved) => {
              /*
               * Dropped on a refusal, so the server's value stands again. The
               * dangerous direction is closing: the board unticks the box, the
               * request fails, and a panel that kept the attempted value would
               * report a public sign-up route as shut while it is still open on
               * an instance holding a statutory register of personal data.
               */
              if (!saved) {
                setAttempted(null);
              }
            });
          }}
          className="size-4"
        />
        {t("settings.selfSignup.enabled")}
      </label>

      {/* The state in words. A checkbox alone is a shape, and this decides
          whether a public form exists. */}
      <p className="text-small text-ink-muted">
        {on
          ? t("settings.selfSignup.stateOn")
          : t("settings.selfSignup.stateOff")}
      </p>
    </Panel>
  );
}

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
  const [on, setOn] = useState(enabled);

  const save = useSaveAction(saveSelfSignup, (value) => {
    setOn(value.enabled);
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
            setOn(next);
            void save.submit({ enabled: next });
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

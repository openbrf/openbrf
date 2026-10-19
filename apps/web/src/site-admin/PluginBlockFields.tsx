import type {
  PluginBlockDeclaration,
  PluginBlockSettingValue,
} from "@openbrf/shared";
import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";

import { SettingsField } from "../plugins/PluginSettingsForm";
import { usePluginTranslation } from "../plugins/use-plugin-translation";
import { HINT } from "../ui/controls";
import { Notice } from "../ui/Notice";

export interface PluginBlockFieldsProps {
  declaration: PluginBlockDeclaration;
  settings: Readonly<Record<string, PluginBlockSettingValue>>;
  onChange: (key: string, value: PluginBlockSettingValue | undefined) => void;
  /**
   * Whether the block is stored but no longer holds what the plugin asks for,
   * which holds back every save until the board answers it.
   */
  unfinished?: boolean;
}

/**
 * A plugin's website block, as the board sets it up.
 *
 * The form is drawn from the block's declared settings with the controls the
 * plugin's own settings screen uses, so a plugin brings no control of its own
 * to the page editor either. What the block shows is not drawn here: the
 * plugin decides that when the page is rendered, and the preview is where the
 * board sees it.
 */
export function PluginBlockFields({
  declaration,
  settings,
  onChange,
  unfinished = false,
}: PluginBlockFieldsProps): ReactElement {
  const { t } = useTranslation();
  const translate = usePluginTranslation(declaration.pluginId);

  return (
    <div className="flex flex-col gap-3">
      <p className={HINT}>{t("siteAdmin.editor.pluginBlockHint")}</p>
      {unfinished ? (
        <Notice tone="warn">
          {t("siteAdmin.editor.pluginBlockUnfinished")}
        </Notice>
      ) : null}
      {declaration.fields.map((field) => (
        <SettingsField
          key={field.key}
          field={field}
          value={settings[field.key]}
          editable
          label={translate(field.labelKey)}
          hint={
            field.hintKey === undefined ? undefined : translate(field.hintKey)
          }
          translateOption={translate}
          onChange={onChange}
        />
      ))}
    </div>
  );
}

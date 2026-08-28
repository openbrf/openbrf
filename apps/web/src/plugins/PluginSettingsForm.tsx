import type {
  PluginSettingsField,
  PluginSettingsSchema,
  PluginSettingsValues,
} from "@openbrf/plugin-sdk";
import { useEffect, useState, type FormEvent, type ReactElement } from "react";
import { useTranslation } from "react-i18next";

import { FIELD, FIELD_DATA, HINT, LABEL, PRIMARY_BUTTON } from "../ui/controls";
import { Notice } from "../ui/Notice";
import { failureMessageKey, useSaveAction } from "../ui/save-state";
import { savePluginSettings } from "./plugin-api";
import { loadPluginTranslations } from "./plugin-i18n";
import { usePluginTranslation } from "./use-plugin-translation";

export interface PluginSettingsFormProps {
  pluginId: string;
  schema: PluginSettingsSchema;
  values: PluginSettingsValues;
  editable?: boolean;
  onSaved?: (values: PluginSettingsValues) => void;
}

/**
 * A plugin's settings form, rendered from its declaration.
 *
 * The plugin ships a settingsSchema and the host draws the form. That is not a
 * convenience for the plugin author: it is what keeps plugin settings looking
 * like the rest of the product, keeps them on the same controls and the same
 * tokens, and - the part that matters - keeps the values validated on the
 * server against the same declaration, rather than only in a form the plugin
 * drew for itself.
 *
 * Labels are keys in the plugin's own namespace, merged at runtime from its
 * locale files, so a Swedish board reads Swedish labels for a plugin this
 * application has never seen.
 */
export function PluginSettingsForm({
  pluginId,
  schema,
  values,
  editable = true,
  onSaved,
}: PluginSettingsFormProps): ReactElement {
  const { t } = useTranslation();
  const translatePlugin = usePluginTranslation(pluginId);
  const [draft, setDraft] = useState<PluginSettingsValues>(values);
  const [translationsReady, setTranslationsReady] = useState(false);

  useEffect(() => {
    let active = true;
    void loadPluginTranslations(pluginId).then(() => {
      if (active) {
        // Flips once the bundle is in the store, so the labels re-render as
        // words rather than staying on whatever i18next answered first.
        setTranslationsReady(true);
      }
    });
    return () => {
      active = false;
    };
  }, [pluginId]);

  const save = useSaveAction(
    (next: PluginSettingsValues) => savePluginSettings(pluginId, next),
    (response) => onSaved?.(response.values),
  );

  const onSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    void save.submit(draft);
  };

  /**
   * Applies one field's value to the draft.
   *
   * `undefined` drops the key rather than storing it. An emptied optional box
   * means "unset", and the declaration on the server is what decides whether
   * that is allowed - sending a value the field never held would answer that
   * question here, in the browser, and wrongly.
   */
  const set = (
    key: string,
    value: string | number | boolean | undefined,
  ): void => {
    setDraft((current) => {
      if (value !== undefined) {
        return { ...current, [key]: value };
      }
      const next = { ...current };
      delete next[key];
      return next;
    });
  };

  if (schema.fields.length === 0) {
    return (
      <p className="text-small text-ink-muted">{t("plugins.settings.none")}</p>
    );
  }

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={onSubmit}
      // Remounted when the translations land so every label is re-read at
      // once, rather than each field deciding for itself.
      key={String(translationsReady)}
    >
      {schema.fields.map((field) => (
        <SettingsField
          key={field.key}
          field={field}
          value={draft[field.key]}
          editable={editable}
          label={translatePlugin(field.labelKey)}
          hint={
            field.hintKey === undefined
              ? undefined
              : translatePlugin(field.hintKey)
          }
          translateOption={translatePlugin}
          onChange={set}
        />
      ))}

      {save.state.kind === "failed" ? (
        <Notice tone="danger" live>
          {t(
            failureMessageKey(
              save.state.failure,
              { "invalid-body": "plugins.settings.errors.invalid" },
              "plugins.errors.unknown",
            ),
          )}
        </Notice>
      ) : save.state.kind === "saved" ? (
        <Notice tone="ok" live>
          {t("plugins.settings.saved")}
        </Notice>
      ) : null}

      {editable ? (
        <div>
          <button
            type="submit"
            disabled={save.state.kind === "saving"}
            className={PRIMARY_BUTTON}
          >
            {save.state.kind === "saving"
              ? t("plugins.settings.saving")
              : t("plugins.settings.save")}
          </button>
        </div>
      ) : null}
    </form>
  );
}

interface SettingsFieldProps {
  field: PluginSettingsField;
  value: string | number | boolean | undefined;
  editable: boolean;
  label: string;
  hint: string | undefined;
  translateOption: (key: string) => string;
  onChange: (key: string, value: string | number | boolean | undefined) => void;
}

/**
 * One declared field.
 *
 * Every type resolves to a control the rest of the product already uses, so a
 * plugin cannot introduce a widget nobody else has: the shapes DESIGN.md fixes
 * apply to a plugin's settings exactly as they do to the housing
 * cooperative's own.
 */
function SettingsField({
  field,
  value,
  editable,
  label,
  hint,
  translateOption,
  onChange,
}: SettingsFieldProps): ReactElement {
  const help = hint === undefined ? null : <span className={HINT}>{hint}</span>;

  if (field.type === "boolean") {
    return (
      // min-h-11 is the 44px touch target, as on every other control here.
      <label className="flex min-h-11 items-start gap-3">
        <input
          type="checkbox"
          name={field.key}
          disabled={!editable}
          checked={value === true}
          onChange={(event) => {
            onChange(field.key, event.target.checked);
          }}
          className="mt-1 size-5 rounded-control border border-line-strong"
        />
        <span className="flex flex-col gap-1">
          <span className="text-body text-ink">{label}</span>
          {help}
        </span>
      </label>
    );
  }

  if (field.type === "select") {
    return (
      <label className={LABEL}>
        {label}
        <select
          name={field.key}
          disabled={!editable}
          value={typeof value === "string" ? value : ""}
          onChange={(event) => {
            onChange(field.key, event.target.value);
          }}
          className={FIELD}
        >
          {field.options.map((option) => (
            <option key={option.value} value={option.value}>
              {translateOption(option.labelKey)}
            </option>
          ))}
        </select>
        {help}
      </label>
    );
  }

  if (field.type === "number") {
    return (
      <label className={LABEL}>
        {label}
        <input
          type="number"
          name={field.key}
          disabled={!editable}
          min={field.min}
          max={field.max}
          step={field.integer ? 1 : "any"}
          value={typeof value === "number" ? String(value) : ""}
          onChange={(event) => {
            const raw = event.target.value;
            const parsed = Number(raw);
            onChange(
              field.key,
              // An empty box is not the number zero, and Number("") is: sent
              // as 0 it would silently become a value the plugin acts on -
              // a reminderDays of 0 rather than a field left unset. Absence
              // goes to the server as absence, and the declared schema
              // decides whether the field may be unset.
              raw === "" || Number.isNaN(parsed) ? undefined : parsed,
            );
          }}
          className={FIELD_DATA}
        />
        {help}
      </label>
    );
  }

  return (
    <label className={LABEL}>
      {label}
      <input
        type="text"
        name={field.key}
        disabled={!editable}
        maxLength={field.maxLength}
        value={typeof value === "string" ? value : ""}
        onChange={(event) => {
          onChange(field.key, event.target.value);
        }}
        className={FIELD}
      />
      {help}
    </label>
  );
}

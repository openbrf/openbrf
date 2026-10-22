import type {
  PluginSettingsField,
  PluginSettingsSchema,
  PluginSettingsValues,
} from "@openbrf/plugin-sdk";
import type { PluginBlockField } from "@openbrf/shared";
import {
  useEffect,
  useId,
  useState,
  type FormEvent,
  type ReactElement,
} from "react";
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
  /** The secret fields that hold a value. Their values never reach the form. */
  secretsSet?: readonly string[];
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
 *
 * A secret field is write-only (ADR 0037). The API says whether it holds a
 * value and never what it is, so the form starts it empty, sends it only when
 * the board typed a new one or asked for it to be removed, and leaves it out
 * otherwise, which keeps what is stored.
 */
export function PluginSettingsForm({
  pluginId,
  schema,
  values,
  secretsSet = [],
  editable = true,
  onSaved,
}: PluginSettingsFormProps): ReactElement {
  const { t } = useTranslation();
  const translatePlugin = usePluginTranslation(pluginId);
  const [draft, setDraft] = useState<PluginSettingsValues>(values);
  const [secrets, setSecrets] = useState<Record<string, string | null>>({});
  const [stored, setStored] = useState<readonly string[]>(secretsSet);
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
    (next: {
      values: PluginSettingsValues;
      secrets: Record<string, string | null>;
    }) => savePluginSettings(pluginId, next.values, next.secrets),
    (response) => {
      // What is stored now, and nothing typed left in a field: a secret
      // shown back after the save would be the value the API never returns.
      setStored(response.secretsSet);
      setSecrets({});
      onSaved?.(response.values);
    },
  );

  const onSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    void save.submit({ values: draft, secrets });
  };

  /** Applies one secret field's change; `undefined` keeps what is stored. */
  const setSecret = (key: string, value: string | null | undefined): void => {
    setSecrets((current) => {
      if (value !== undefined) {
        return { ...current, [key]: value };
      }
      const next = { ...current };
      delete next[key];
      return next;
    });
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
      {schema.fields.map((field) => {
        const label = translatePlugin(field.labelKey);
        const hint =
          field.hintKey === undefined
            ? undefined
            : translatePlugin(field.hintKey);
        return field.type === "secret" ? (
          <SecretSettingField
            key={field.key}
            field={field}
            stored={stored.includes(field.key)}
            change={secrets[field.key]}
            editable={editable}
            label={label}
            hint={hint}
            onChange={setSecret}
          />
        ) : (
          <SettingsField
            key={field.key}
            field={field}
            value={draft[field.key]}
            editable={editable}
            label={label}
            hint={hint}
            translateOption={translatePlugin}
            onChange={set}
          />
        );
      })}

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

export interface SettingsFieldProps {
  /**
   * One declared field: a plugin's own setting, or one of its website block's.
   * The manifest declares both the same way.
   */
  field: PluginBlockField;
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
 * cooperative's own. Exported for the page editor, which draws a plugin's
 * website block's settings with the same controls.
 */
export function SettingsField({
  field,
  value,
  editable,
  label,
  hint,
  translateOption,
  onChange,
}: SettingsFieldProps): ReactElement {
  const { t } = useTranslation();
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
    const chosen =
      typeof value === "string" &&
      field.options.some((option) => option.value === value)
        ? value
        : undefined;
    return (
      <label className={LABEL}>
        {label}
        <select
          name={field.key}
          disabled={!editable}
          aria-required={field.required || undefined}
          value={chosen ?? ""}
          onChange={(event) => {
            onChange(field.key, event.target.value);
          }}
          className={FIELD}
        >
          {/*
           * A value that is none of the options - nothing chosen yet, or one
           * an upgraded plugin no longer offers - is shown as just that. Left
           * to itself the browser would show the first option, which is not
           * what is held, and choosing it would change nothing: with a single
           * option left, there would be no way to answer the field at all.
           */}
          {chosen === undefined ? (
            <option value="" disabled>
              {t(
                value === undefined
                  ? "plugins.settings.choose"
                  : "plugins.settings.noLongerOffered",
              )}
            </option>
          ) : null}
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
          aria-required={field.required || undefined}
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
        aria-required={field.required || undefined}
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

interface SecretSettingFieldProps {
  field: Extract<PluginSettingsField, { type: "secret" }>;
  /** Whether a value is stored. */
  stored: boolean;
  /** What the save will do: a new value, null to remove it, or keep it. */
  change: string | null | undefined;
  editable: boolean;
  label: string;
  hint: string | undefined;
  onChange: (key: string, value: string | null | undefined) => void;
}

/**
 * One secret field: an API key, a token.
 *
 * The SMTP password's controls, for the same reason: the value is never sent
 * to the browser, so the box starts empty, says when a value is stored, and is
 * left empty to keep it. Removing it is its own checkbox rather than an
 * emptied box, which would be indistinguishable from leaving it alone. A
 * required field offers no removal, because the save would be refused.
 */
function SecretSettingField({
  field,
  stored,
  change,
  editable,
  label,
  hint,
  onChange,
}: SecretSettingFieldProps): ReactElement {
  const { t } = useTranslation();
  const statusId = useId();
  const hintId = useId();
  const removing = change === null;

  return (
    <div className="flex flex-col gap-1">
      <label className={LABEL}>
        {label}
        <input
          type="password"
          name={field.key}
          autoComplete="new-password"
          disabled={!editable || removing}
          // Required only where nothing is stored: a stored value satisfies
          // the field, and the box is left empty to keep it.
          aria-required={(field.required && !stored) || undefined}
          aria-describedby={
            hint === undefined ? statusId : `${statusId} ${hintId}`
          }
          maxLength={field.maxLength}
          value={typeof change === "string" ? change : ""}
          onChange={(event) => {
            onChange(
              field.key,
              event.target.value === "" ? undefined : event.target.value,
            );
          }}
          className={FIELD}
        />
      </label>
      {/* Outside the label, so the field's name is its label alone and the
          state of what is stored is read as its description. */}
      <span id={statusId} className={HINT}>
        {t(
          stored
            ? "plugins.settings.secret.stored"
            : "plugins.settings.secret.notStored",
        )}
      </span>
      {hint === undefined ? null : (
        <span id={hintId} className={HINT}>
          {hint}
        </span>
      )}
      {stored && editable && !field.required ? (
        <label className="flex min-h-11 items-center gap-2 text-small">
          <input
            type="checkbox"
            name={`${field.key}-remove`}
            checked={removing}
            onChange={(event) => {
              onChange(field.key, event.target.checked ? null : undefined);
            }}
            className="size-4"
          />
          {t("plugins.settings.secret.remove")}
        </label>
      ) : null}
    </div>
  );
}

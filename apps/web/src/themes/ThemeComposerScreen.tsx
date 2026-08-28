import { normalizeColor, PORTTAVLAN_ID } from "@openbrf/tokens";
import { Link, useNavigate } from "@tanstack/react-router";
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type FormEvent,
  type ReactElement,
} from "react";
import { useTranslation } from "react-i18next";

import type { ApiFailure } from "../api/client";
import {
  composeTheme,
  fetchInstalledThemes,
  fetchThemePreview,
  fetchThemeSource,
  type ComposeThemeInput,
  type ThemeRendering,
  type ThemeSummary,
  type ThemeTokenValues,
} from "../api/themes";
import type { TranslationKey } from "../i18n/translation-key";
import { useThemeRuntime } from "../theme/theme-runtime-context";
import {
  FIELD,
  FIELD_DATA,
  HINT,
  LABEL,
  PRIMARY_BUTTON,
  QUIET_BUTTON,
  SECONDARY_BUTTON,
} from "../ui/controls";
import { Notice } from "../ui/Notice";
import { Panel } from "../ui/Panel";
import { useSaveAction } from "../ui/save-state";
import {
  builtInRendering,
  composerGroups,
  draftFindings,
  draftRendering,
  pruneOverrides,
  type ComposerGroup,
} from "./composer-draft";
import { LintFindings } from "./LintFindings";
import { failureKey, findingsOf } from "./theme-failures";

/**
 * Composing a theme on the instance.
 *
 * An administrator names a theme, chooses the theme it inherits from, and
 * changes the colours they want changed. Everything they leave alone is
 * inherited, so what is saved is the handful of values they actually chose -
 * the same four-line child theme a theme author would have written by hand.
 *
 * The preview is the honest part, and it is the same mechanism the theme screen
 * uses: the draft is applied to this browser and to nothing else, so nobody
 * else sees a half-finished theme and nothing is written until it is saved.
 *
 * The contrast measured while typing is advice. The install lint on the server
 * is the gate, it runs again on every save, and the copy on the screen says so:
 * the register pairs are statutory, and a board must not be left believing that
 * a browser-side measurement is what decides.
 */

export interface ThemeComposerScreenProps {
  /** The theme to edit. Absent composes a new one. */
  themeId?: string | undefined;
}

/** One mode's overrides, keyed by token name. */
interface DraftOverrides {
  light: ThemeTokenValues;
  dark: ThemeTokenValues;
}

const EMPTY_OVERRIDES: DraftOverrides = { light: {}, dark: {} };

const GROUPS: readonly ComposerGroup[] = composerGroups();

/**
 * The default theme as a parent, built once.
 *
 * A stable value rather than a call per render: it is a dependency of the draft
 * the preview is derived from, and a new object each render would re-apply the
 * same stylesheet on every keystroke.
 */
const BUILT_IN_PARENT = builtInRendering();

/**
 * What each colour is for, in the reader's own language.
 *
 * The token contract states every role in English, and this interface is
 * Swedish by default, so the sentence is a translation of the token name rather
 * than the contract's own prose. A colour from a newer contract still gets a
 * row, with a sentence saying this version cannot describe it.
 */
const ROLE_KEYS: Readonly<Record<string, TranslationKey>> = {
  "surface-page": "themeCatalog.composer.roles.surface-page",
  "surface-raised": "themeCatalog.composer.roles.surface-raised",
  "surface-sunken": "themeCatalog.composer.roles.surface-sunken",
  "text-primary": "themeCatalog.composer.roles.text-primary",
  "text-secondary": "themeCatalog.composer.roles.text-secondary",
  "border-subtle": "themeCatalog.composer.roles.border-subtle",
  "border-strong": "themeCatalog.composer.roles.border-strong",
  "surface-register": "themeCatalog.composer.roles.surface-register",
  "surface-register-raised":
    "themeCatalog.composer.roles.surface-register-raised",
  "text-register": "themeCatalog.composer.roles.text-register",
  "text-register-secondary":
    "themeCatalog.composer.roles.text-register-secondary",
  "border-register": "themeCatalog.composer.roles.border-register",
  "accent-trust": "themeCatalog.composer.roles.accent-trust",
  "accent-trust-hover": "themeCatalog.composer.roles.accent-trust-hover",
  "accent-trust-soft": "themeCatalog.composer.roles.accent-trust-soft",
  "accent-trust-register": "themeCatalog.composer.roles.accent-trust-register",
  "on-accent-trust": "themeCatalog.composer.roles.on-accent-trust",
  "status-ok": "themeCatalog.composer.roles.status-ok",
  "status-ok-soft": "themeCatalog.composer.roles.status-ok-soft",
  "status-warn": "themeCatalog.composer.roles.status-warn",
  "status-warn-soft": "themeCatalog.composer.roles.status-warn-soft",
  "status-warn-register": "themeCatalog.composer.roles.status-warn-register",
  "status-danger": "themeCatalog.composer.roles.status-danger",
  "status-danger-soft": "themeCatalog.composer.roles.status-danger-soft",
  "on-status-danger": "themeCatalog.composer.roles.on-status-danger",
  "status-info": "themeCatalog.composer.roles.status-info",
  "status-info-soft": "themeCatalog.composer.roles.status-info-soft",
};

export function ThemeComposerScreen({
  themeId,
}: ThemeComposerScreenProps): ReactElement {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const runtime = useThemeRuntime();

  /*
   * The setter rather than the runtime object. The runtime's value changes
   * identity every time a preview is applied, so an effect depending on it
   * would apply a new draft, be re-run by its own change, and never settle.
   */
  const preview = runtime.preview;

  const editing = themeId !== undefined && themeId !== "";

  const [id, setId] = useState(themeId ?? "");
  const [displayName, setDisplayName] = useState("");
  const [description, setDescription] = useState("");
  const [base, setBase] = useState(PORTTAVLAN_ID);
  const [mode, setMode] = useState<"light" | "dark">("light");
  const [overrides, setOverrides] = useState<DraftOverrides>(EMPTY_OVERRIDES);

  const [installed, setInstalled] = useState<ThemeSummary[] | null>(null);
  /** The rendering read for a parent, together with the parent it is of. */
  const [fetched, setFetched] = useState<{
    base: string;
    rendering: ThemeRendering;
  } | null>(null);
  const [loadFailure, setLoadFailure] = useState<ApiFailure | null>(null);
  /** Set when the theme named in the address is not one the composer owns. */
  const [notComposed, setNotComposed] = useState(false);
  const [prefilled, setPrefilled] = useState(!editing);

  // --- What there is to inherit from ---------------------------------------
  useEffect(() => {
    let live = true;
    void fetchInstalledThemes().then((result) => {
      if (!live) {
        return;
      }
      if (result.ok) {
        setInstalled(result.value);
      } else {
        setLoadFailure(result.failure);
      }
    });
    return () => {
      live = false;
    };
  }, []);

  // --- The theme being edited ----------------------------------------------
  useEffect(() => {
    if (themeId === undefined || themeId === "") {
      return;
    }

    let live = true;
    void fetchThemeSource(themeId).then((result) => {
      if (!live) {
        return;
      }
      if (!result.ok) {
        setLoadFailure(result.failure);
        return;
      }
      if (!result.value.composed) {
        // Reachable only by typing the address: the list offers no edit link
        // for a theme that came from a catalog.
        setNotComposed(true);
        return;
      }
      setDisplayName(result.value.displayName);
      setDescription(result.value.description ?? "");
      setBase(result.value.extendsThemeId ?? PORTTAVLAN_ID);
      setOverrides({
        light: { ...result.value.modes.light },
        dark: { ...result.value.modes.dark },
      });
      setPrefilled(true);
    });
    return () => {
      live = false;
    };
  }, [themeId]);

  // --- What the chosen parent renders --------------------------------------
  useEffect(() => {
    // The default theme's values ship with the application, so asking the
    // server for them would be a request for something already here.
    if (base === PORTTAVLAN_ID) {
      return;
    }

    let live = true;
    void fetchThemePreview(base).then((result) => {
      if (!live) {
        return;
      }
      if (result.ok) {
        setFetched({ base, rendering: result.value });
      } else {
        setLoadFailure(result.failure);
      }
    });
    return () => {
      live = false;
    };
  }, [base]);

  /*
   * Derived rather than stored, and matched to the parent it was read for. A
   * rendering left over from the previous choice would be laid under the draft
   * for as long as the new one took to arrive, which is exactly the moment a
   * board is looking at the preview to decide.
   */
  const parent =
    base === PORTTAVLAN_ID
      ? BUILT_IN_PARENT
      : fetched?.base === base
        ? fetched.rendering
        : null;

  // --- The draft, and the browser it is applied to -------------------------
  const draft = useMemo(
    () =>
      parent === null
        ? null
        : draftRendering(parent, { displayName, modes: overrides }),
    [parent, displayName, overrides],
  );

  useEffect(() => {
    if (draft !== null) {
      preview(draft);
    }
  }, [draft, preview]);

  /*
   * The draft goes with the screen. Leaving it applied would show a board
   * member a theme nobody saved on every other screen they opened, and offer
   * to activate it from the theme screen's preview notice.
   */
  useEffect(() => {
    return () => {
      preview(null);
    };
  }, [preview]);

  const onSaved = useCallback((): void => {
    preview(null);
    void navigate({ to: "/admin/themes" });
  }, [navigate, preview]);

  const save = useSaveAction(composeTheme, onSaved);

  const onSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (parent === null) {
      return;
    }

    const trimmedDescription = description.trim();
    const input: ComposeThemeInput = {
      id: id.trim(),
      displayName: displayName.trim(),
      ...(trimmedDescription === "" ? {} : { description: trimmedDescription }),
      extends: base,
      // Pruned here as well as in the preview: what is saved is what the board
      // changed, not every colour the form happened to render.
      modes: {
        light: pruneOverrides(parent.modes.light, overrides.light),
        dark: pruneOverrides(parent.modes.dark, overrides.dark),
      },
    };

    void save.submit(input);
  };

  const setOverride = (token: string, value: string): void => {
    setOverrides((current) => ({
      ...current,
      [mode]: { ...current[mode], [token]: value },
    }));
  };

  const clearOverride = (token: string): void => {
    setOverrides((current) => {
      const next = { ...current[mode] };
      delete next[token];
      return { ...current, [mode]: next };
    });
  };

  const findings = draft === null ? [] : draftFindings(draft);

  /** Every installed theme may be inherited from, except this one itself. */
  const parents = (installed ?? []).filter(
    (theme) => !editing || theme.id !== themeId,
  );

  if (notComposed) {
    return (
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-5">
        <Notice tone="info">{t("themeCatalog.errors.themeNotComposed")}</Notice>
        <div>
          <Link to="/admin/themes" className={SECONDARY_BUTTON}>
            {t("themeCatalog.composer.cancel")}
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-5">
      <header className="flex flex-col gap-1">
        <h1 className="text-display">
          {editing
            ? t("themeCatalog.composer.editTitle", {
                theme: displayName === "" ? (themeId ?? "") : displayName,
              })
            : t("themeCatalog.composer.title")}
        </h1>
        <p className="text-body text-ink-muted">
          {t("themeCatalog.composer.intro")}
        </p>
      </header>

      {loadFailure === null ? null : (
        <Notice tone="danger" live>
          {t(failureKey(loadFailure))}
        </Notice>
      )}

      <Notice tone="info">
        {t("themeCatalog.composer.livePreviewNotice")}
      </Notice>

      {save.state.kind === "failed" ? (
        <Notice tone="danger" live>
          <span className="flex flex-col gap-2">
            <span>{t(failureKey(save.state.failure))}</span>
            <LintFindings findings={findingsOf(save.state.failure)} />
          </span>
        </Notice>
      ) : null}

      {!prefilled || parent === null ? (
        <p role="status" className="text-body text-ink-muted">
          {t("themeCatalog.loading")}
        </p>
      ) : (
        <form className="flex flex-col gap-5" onSubmit={onSubmit}>
          <Panel title={t("themeCatalog.composer.identityTitle")}>
            <label className={LABEL}>
              {t("themeCatalog.composer.idLabel")}
              <input
                type="text"
                name="id"
                autoComplete="off"
                spellCheck={false}
                /* The id is the theme's identity on disk, in the row and in
                   every other theme's `extends`. Changing it would be a new
                   theme, not an edit of this one. */
                readOnly={editing}
                value={id}
                onChange={(event) => {
                  setId(event.target.value);
                }}
                className={FIELD_DATA}
              />
              <span className={HINT}>{t("themeCatalog.composer.idHint")}</span>
            </label>

            <label className={LABEL}>
              {t("themeCatalog.composer.nameLabel")}
              <input
                type="text"
                name="displayName"
                autoComplete="off"
                value={displayName}
                onChange={(event) => {
                  setDisplayName(event.target.value);
                }}
                className={FIELD}
              />
              <span className={HINT}>
                {t("themeCatalog.composer.nameHint")}
              </span>
            </label>

            <label className={LABEL}>
              {t("themeCatalog.composer.descriptionLabel")}
              <input
                type="text"
                name="description"
                autoComplete="off"
                value={description}
                onChange={(event) => {
                  setDescription(event.target.value);
                }}
                className={FIELD}
              />
              <span className={HINT}>
                {t("themeCatalog.composer.descriptionHint")}
              </span>
            </label>

            <label className={LABEL}>
              {t("themeCatalog.composer.baseLabel")}
              <select
                name="extends"
                value={base}
                onChange={(event) => {
                  setBase(event.target.value);
                }}
                className={FIELD}
              >
                {parents.map((theme) => (
                  <option key={theme.id} value={theme.id}>
                    {theme.name}
                  </option>
                ))}
              </select>
              <span className={HINT}>
                {t("themeCatalog.composer.baseHint")}
              </span>
            </label>
          </Panel>

          <Panel
            title={t("themeCatalog.composer.colours")}
            description={t("themeCatalog.composer.inheritNotice")}
          >
            <label className={LABEL}>
              {t("themeCatalog.composer.modeLabel")}
              <select
                name="mode"
                value={mode}
                onChange={(event) => {
                  setMode(event.target.value === "dark" ? "dark" : "light");
                }}
                className={FIELD}
              >
                <option value="light">
                  {t("themeCatalog.composer.modeLight")}
                </option>
                <option value="dark">
                  {t("themeCatalog.composer.modeDark")}
                </option>
              </select>
            </label>

            {GROUPS.map((group) => (
              <section key={group.name} className="flex flex-col gap-3">
                <h3 className="text-label text-ink-muted uppercase">
                  {t(group.labelKey)}
                </h3>
                {group.tokens.map((token) => (
                  <ColourRow
                    key={token}
                    token={token}
                    inherited={parent.modes[mode][token] ?? ""}
                    override={overrides[mode][token]}
                    onChange={(value) => {
                      setOverride(token, value);
                    }}
                    onClear={() => {
                      clearOverride(token);
                    }}
                  />
                ))}
              </section>
            ))}
          </Panel>

          <Panel
            title={t("themeCatalog.composer.contrastTitle")}
            description={t("themeCatalog.composer.contrastAdvice")}
          >
            {findings.length === 0 ? (
              <p className="text-body">
                {t("themeCatalog.composer.contrastOk")}
              </p>
            ) : (
              <div className="flex flex-col gap-2">
                <p className="text-body">
                  {t("themeCatalog.composer.contrastFailures")}
                </p>
                <LintFindings findings={findings} />
              </div>
            )}
          </Panel>

          <div className="flex flex-wrap gap-3">
            <button
              type="submit"
              disabled={save.state.kind === "saving"}
              className={PRIMARY_BUTTON}
            >
              {save.state.kind === "saving"
                ? t("themeCatalog.composer.saving")
                : t("themeCatalog.composer.save")}
            </button>

            <Link to="/admin/themes" className={SECONDARY_BUTTON}>
              {t("themeCatalog.composer.cancel")}
            </Link>
          </div>
        </form>
      )}
    </div>
  );
}

/**
 * One colour: what it is for, what it inherits, and the value this theme gives
 * it instead.
 *
 * The inherited value is the placeholder rather than the value, so an empty
 * field reads as "inherits this" instead of as "is this". That distinction is
 * the whole difference between a child theme and a copy of its parent.
 */
function ColourRow({
  token,
  inherited,
  override,
  onChange,
  onClear,
}: {
  token: string;
  inherited: string;
  override: string | undefined;
  onChange: (value: string) => void;
  onClear: () => void;
}): ReactElement {
  const { t } = useTranslation();

  const effective =
    override === undefined || override.trim() === "" ? inherited : override;
  /*
   * The colour input speaks only in six-digit hex, and it is a control rather
   * than a surface: this is the same documented exception the accent picker
   * takes, where a literal colour is the point rather than a defect.
   */
  const swatch = normalizeColor(effective) ?? "#000000";
  const roleKey = ROLE_KEYS[token] ?? "themeCatalog.composer.roles.unknown";

  return (
    <div className="flex flex-col gap-2 border-t border-line pt-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="font-data text-data">{token}</span>
        <span className={HINT}>{t(roleKey)}</span>
        {/* Written as well as shown in the swatch: what a colour inherits is
            part of the decision, and a placeholder disappears on the first
            keystroke. */}
        <span className="font-data text-data text-ink-muted">
          {t("themeCatalog.composer.inherited", { value: inherited })}
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <input
          type="color"
          aria-label={t("themeCatalog.composer.overrideColour", { token })}
          value={swatch}
          onChange={(event) => {
            onChange(event.target.value);
          }}
          className="h-11 w-11 rounded-control border border-line-strong bg-raised"
        />
        <input
          type="text"
          aria-label={t("themeCatalog.composer.override", { token })}
          autoComplete="off"
          spellCheck={false}
          placeholder={inherited}
          value={override ?? ""}
          onChange={(event) => {
            onChange(event.target.value);
          }}
          onBlur={(event) => {
            // Written as the theme will store it, so two spellings of one
            // colour cannot look like two different values.
            const normalized = normalizeColor(event.target.value);
            if (normalized !== null) {
              onChange(normalized);
            }
          }}
          className={`${FIELD_DATA} w-36`}
        />
        {override === undefined ? null : (
          <button type="button" className={QUIET_BUTTON} onClick={onClear}>
            {t("themeCatalog.composer.clearOverride")}
          </button>
        )}
      </div>
    </div>
  );
}

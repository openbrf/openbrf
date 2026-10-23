import { Link } from "@tanstack/react-router";
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactElement,
} from "react";
import { useTranslation } from "react-i18next";

import type { TranslationKey } from "../i18n/translation-key";
import { BoardPageNote, BoardPageTitle } from "../ui/BoardPage";
import { copyText } from "../ui/clipboard";
import {
  FIELD,
  FIELD_MULTILINE,
  HINT,
  LABEL,
  PRIMARY_BUTTON,
  SECONDARY_BUTTON,
} from "../ui/controls";
import { LoadFailure } from "../ui/LoadFailure";
import { Notice } from "../ui/Notice";
import { Panel } from "../ui/Panel";
import { failureMessageKey, useSaveAction } from "../ui/save-state";
import {
  fetchDisplayLinkOptions,
  issueDisplayToken,
  type DisplayLinkOptions,
  type IssuedDisplayToken,
} from "./display-api";
import {
  DEFAULT_CHOICES,
  DISPLAY_SOURCES,
  displayLink,
  MAX_DISPLAY_RESOURCES,
  type DisplayChoices,
  type DisplaySource,
} from "./display-link";
import { QrCode } from "./QrCode";

/** The longest name the board may give a screen, as the API checks it. */
const LABEL_MAX_LENGTH = 80;

const ISSUE_FAILURES: Readonly<Record<string, TranslationKey>> = {
  "device-label-invalid": "display.errors.labelInvalid",
  "device-token-limit": "display.errors.limit",
};

const SOURCE_KEYS: Readonly<Record<DisplaySource, TranslationKey>> = {
  news: "display.sources.news",
  events: "display.sources.events",
  meeting: "display.sources.meeting",
  availability: "display.sources.availability",
};

const ORIENTATIONS = [0, 90, 180, 270] as const;

/**
 * The board's display screen (ADR 0050): issuing a display link for a screen
 * in the building.
 *
 * The board names the screen, chooses what it shows and how, and is given
 * the link once, as text and as a QR code, to open on the screen. The choices
 * are written into the link and kept nowhere: the screen's link is where they
 * are, and showing a screen something else means opening a different link on
 * it. The token is the one thing the instance keeps, on the devices screen,
 * where any board member may revoke it.
 *
 * The link is composed in the browser from the choices as they stand, so a
 * choice changed after the token is issued changes the link shown with it.
 * The token itself is in this screen's memory only and is gone when the board
 * leaves it or asks for another.
 */
export function DisplayScreen(): ReactElement {
  const { t } = useTranslation();
  const formId = useId();
  const [options, setOptions] = useState<DisplayLinkOptions | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [label, setLabel] = useState("");
  const [choices, setChoices] = useState<DisplayChoices>(DEFAULT_CHOICES);
  const [issued, setIssued] = useState<IssuedDisplayToken | null>(null);
  const [copied, setCopied] = useState<"copied" | "failed" | null>(null);
  /** Only the newest read may be applied. */
  const currentRead = useRef(0);

  const read = useCallback((): void => {
    const version = ++currentRead.current;
    void fetchDisplayLinkOptions().then((result) => {
      if (version !== currentRead.current) {
        return;
      }
      setLoadFailed(!result.ok);
      if (result.ok) {
        setOptions(result.value);
      }
    });
  }, []);

  useEffect(() => {
    read();
    return () => {
      currentRead.current += 1;
    };
  }, [read]);

  const issue = useSaveAction(
    async (name: string) => issueDisplayToken(name.trim()),
    (value) => {
      setIssued(value);
      setCopied(null);
    },
  );

  const link =
    issued === null
      ? null
      : displayLink(window.location.origin, issued.token, choices);

  const choose = (next: Partial<DisplayChoices>): void => {
    setChoices((current) => ({ ...current, ...next }));
    // A copy made of the previous link is no longer this one.
    setCopied(null);
  };

  const toggleSource = (source: DisplaySource, on: boolean): void => {
    const sources = on
      ? [...choices.sources, source]
      : choices.sources.filter((one) => one !== source);
    choose({ sources: DISPLAY_SOURCES.filter((one) => sources.includes(one)) });
  };

  const toggleResource = (id: string, on: boolean): void => {
    choose({
      resources: on
        ? [...choices.resources, id]
        : choices.resources.filter((one) => one !== id),
    });
  };

  const failureKey =
    issue.state.kind === "failed"
      ? failureMessageKey(
          issue.state.failure,
          ISSUE_FAILURES,
          "display.errors.issueFailed",
        )
      : null;

  const trimmed = label.trim();
  const canIssue =
    !issue.pending &&
    issued === null &&
    trimmed !== "" &&
    trimmed.length <= LABEL_MAX_LENGTH &&
    choices.sources.length > 0;

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-5">
      <header className="flex flex-col gap-1">
        <BoardPageTitle>{t("display.title")}</BoardPageTitle>
        <BoardPageNote />
        <p className="text-body text-ink-muted">{t("display.intro")}</p>
        <p className="text-body">
          <Link className="text-trust underline" to="/board/site/devices">
            {t("display.devicesLink")}
          </Link>
        </p>
      </header>

      {loadFailed ? (
        <LoadFailure
          messageKey="display.loadFailed"
          onRetry={() => {
            setLoadFailed(false);
            read();
          }}
        />
      ) : null}

      {options === null && !loadFailed ? (
        <p role="status" className="text-body text-ink-muted">
          {t("display.loading")}
        </p>
      ) : null}

      {options === null ? null : (
        <Panel
          title={t("display.form.title")}
          description={t("display.form.description", {
            language: t(
              options.defaultLocale === "en"
                ? "display.form.localeEn"
                : "display.form.localeSv",
            ),
          })}
          notice={<Notice tone="warn">{t("display.form.namesNobody")}</Notice>}
          actions={
            issued === null ? (
              <button
                type="submit"
                form={formId}
                disabled={!canIssue}
                className={PRIMARY_BUTTON}
              >
                {issue.pending
                  ? t("display.form.issuing")
                  : t("display.form.issue")}
              </button>
            ) : (
              <button
                type="button"
                onClick={() => {
                  setIssued(null);
                  setLabel("");
                  setCopied(null);
                  issue.reset();
                }}
                className={SECONDARY_BUTTON}
              >
                {t("display.result.another")}
              </button>
            )
          }
        >
          <form
            id={formId}
            className="flex flex-col gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              if (canIssue) {
                void issue.submit(label);
              }
            }}
          >
            <label className={LABEL}>
              {t("display.form.label")}
              <input
                type="text"
                value={label}
                required
                maxLength={LABEL_MAX_LENGTH}
                disabled={issued !== null}
                onChange={(event) => {
                  setLabel(event.target.value);
                  if (issue.state.kind === "failed") {
                    issue.reset();
                  }
                }}
                className={FIELD}
              />
              <span className={HINT}>{t("display.form.labelHint")}</span>
            </label>

            <fieldset className="flex flex-col gap-1">
              <legend className="text-label text-ink-muted uppercase">
                {t("display.form.sources")}
              </legend>
              {DISPLAY_SOURCES.map((source) => (
                <label
                  key={source}
                  className="flex min-h-11 items-center gap-2 text-small text-ink"
                >
                  <input
                    type="checkbox"
                    checked={choices.sources.includes(source)}
                    onChange={(event) => {
                      toggleSource(source, event.target.checked);
                    }}
                    className="size-4 accent-trust"
                  />
                  {t(SOURCE_KEYS[source])}
                </label>
              ))}
              {choices.sources.length === 0 ? (
                <Notice tone="warn" live>
                  {t("display.form.sourcesNone")}
                </Notice>
              ) : null}
              <span className={HINT}>{t("display.form.sourcesHint")}</span>
            </fieldset>

            {choices.sources.includes("availability") ? (
              <fieldset className="flex flex-col gap-1">
                <legend className="text-label text-ink-muted uppercase">
                  {t("display.form.resources")}
                </legend>
                {options.resources.length === 0 ? (
                  <p className={HINT}>{t("display.form.resourcesNone")}</p>
                ) : (
                  options.resources.map((resource) => {
                    const checked = choices.resources.includes(resource.id);
                    return (
                      <label
                        key={resource.id}
                        className="flex min-h-11 items-center gap-2 text-small text-ink"
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          disabled={
                            !checked &&
                            choices.resources.length >= MAX_DISPLAY_RESOURCES
                          }
                          onChange={(event) => {
                            toggleResource(resource.id, event.target.checked);
                          }}
                          className="size-4 accent-trust"
                        />
                        {resource.name}
                      </label>
                    );
                  })
                )}
                <span className={HINT}>
                  {t("display.form.resourcesHint", {
                    max: MAX_DISPLAY_RESOURCES,
                  })}
                </span>
              </fieldset>
            ) : null}

            <div className="grid gap-4 sm:grid-cols-2">
              <label className={LABEL}>
                {t("display.form.orientation")}
                <select
                  value={String(choices.orientation)}
                  onChange={(event) => {
                    const turned = Number(event.target.value);
                    choose({
                      orientation:
                        ORIENTATIONS.find((one) => one === turned) ?? 0,
                    });
                  }}
                  className={FIELD}
                >
                  {ORIENTATIONS.map((degrees) => (
                    <option key={degrees} value={String(degrees)}>
                      {t("display.form.orientationDegrees", { degrees })}
                    </option>
                  ))}
                </select>
              </label>

              <label className={LABEL}>
                {t("display.form.header")}
                <select
                  value={choices.header}
                  onChange={(event) => {
                    choose({
                      header: event.target.value === "none" ? "none" : "clock",
                    });
                  }}
                  className={FIELD}
                >
                  <option value="clock">{t("display.form.headerClock")}</option>
                  <option value="none">{t("display.form.headerNone")}</option>
                </select>
              </label>

              <label className={LABEL}>
                {t("display.form.theme")}
                <select
                  value={choices.theme}
                  onChange={(event) => {
                    choose({
                      theme: event.target.value === "light" ? "light" : "dark",
                    });
                  }}
                  className={FIELD}
                >
                  <option value="dark">{t("display.form.themeDark")}</option>
                  <option value="light">{t("display.form.themeLight")}</option>
                </select>
              </label>

              <label className={LABEL}>
                {t("display.form.locale")}
                <select
                  value={choices.locale ?? ""}
                  onChange={(event) => {
                    const value = event.target.value;
                    choose({
                      locale: value === "sv" || value === "en" ? value : null,
                    });
                  }}
                  className={FIELD}
                >
                  <option value="">{t("display.form.localeDefault")}</option>
                  <option value="sv">{t("display.form.localeSv")}</option>
                  <option value="en">{t("display.form.localeEn")}</option>
                </select>
              </label>
            </div>

            {failureKey === null ? null : (
              <Notice tone="danger" live>
                {t(failureKey)}
              </Notice>
            )}
          </form>
        </Panel>
      )}

      {issued === null || link === null ? null : (
        <Panel
          title={t("display.result.title", { label: issued.device.label })}
          description={t("display.result.description")}
          notice={
            <Notice tone="warn">{t("display.result.onceWarning")}</Notice>
          }
        >
          <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
            <QrCode text={link} label={t("display.result.qrLabel")} />
            <div className="flex min-w-0 flex-1 flex-col gap-2">
              <label className={LABEL}>
                {t("display.result.link")}
                <textarea
                  readOnly
                  value={link}
                  rows={4}
                  onFocus={(event) => {
                    event.target.select();
                  }}
                  className={`${FIELD_MULTILINE} font-data break-all`}
                />
              </label>
              <div>
                <button
                  type="button"
                  className={SECONDARY_BUTTON}
                  onClick={() => {
                    void copyText(link).then((ok) => {
                      setCopied(ok ? "copied" : "failed");
                    });
                  }}
                >
                  {t("display.result.copy")}
                </button>
              </div>
              {copied === "copied" ? (
                <Notice tone="ok" live>
                  {t("display.result.copied")}
                </Notice>
              ) : copied === "failed" ? (
                <Notice tone="danger" live>
                  {t("display.result.copyFailed")}
                </Notice>
              ) : null}
            </div>
          </div>
        </Panel>
      )}
    </div>
  );
}

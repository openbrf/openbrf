import {
  type IssueAccessWithholdingReason,
  ISSUE_ACCESS_WITHHOLDING_REASONS,
} from "@openbrf/shared";
import { useEffect, useRef, useState } from "react";
import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";

import { localDayOfInstant } from "../bookings/booking-calendar";
import type { TranslationKey } from "../i18n/translation-key";
import { PANEL, PRIMARY_BUTTON, SECONDARY_BUTTON } from "../ui/controls";
import { Notice } from "../ui/Notice";
import {
  type IssueAccessWeighing,
  RegisterRequestError,
  fetchIssueAccessWeighing,
  saveIssueAccessWeighing,
} from "./register-api";
import { usePanelHeadingFocus } from "./use-panel-heading-focus";

/** What the board chose for one text: give it, or leave it out for a reason. */
type Choice = "given" | IssueAccessWithholdingReason;

type Text = IssueAccessWeighing["texts"][number];

/** One text, by its part and, for a message or a note, its identifier. */
function keyOf(text: Pick<Text, "part" | "id">): string {
  return `${text.part}:${text.id ?? ""}`;
}

const PART_LABEL = {
  DESCRIPTION: "register.person.report.weighing.part.DESCRIPTION",
  LOCATION: "register.person.report.weighing.part.LOCATION",
  NOTE: "register.person.report.weighing.part.NOTE",
} as const satisfies Record<Exclude<Text["part"], "MESSAGE">, TranslationKey>;

const CHOICE_LABEL = {
  given: "register.person.report.weighing.choice.given",
  IDENTIFIES_REPORTER:
    "register.person.report.weighing.choice.IDENTIFIES_REPORTER",
  ABOUT_ANOTHER_PERSON:
    "register.person.report.weighing.choice.ABOUT_ANOTHER_PERSON",
} as const satisfies Record<Choice, TranslationKey>;

function partLabel(text: Text): TranslationKey {
  if (text.part !== "MESSAGE") {
    return PART_LABEL[text.part];
  }
  return text.side === "HANDLER"
    ? "register.person.report.weighing.part.MESSAGE_HANDLER"
    : "register.person.report.weighing.part.MESSAGE_REPORTER";
}

/** The association's day of an instant, as the report states every date. */
function day(instant: string): string {
  return localDayOfInstant(instant);
}

export interface IssueAccessWeighingPanelProps {
  personId: string;
  issueId: string;
  onClose: () => void;
  /** The weighing was saved: the report is produced again to show it. */
  onSaved: () => void;
}

/**
 * The board's weighing under GDPR art. 15(4) of one issue's texts for one
 * person's access report (ADR 0057).
 *
 * On the board's screen and never on the paper: it shows the words the report
 * may leave out, so the board can weigh them. Each text is given whole or left
 * out for a stated reason, and the report prints the reason and none of the
 * words. A reporter's own report weighs only the internal notes, and never
 * leaves one out for telling them who reported their own case.
 *
 * Saved whole: every text the panel shows needs a choice, and the save
 * replaces the weighing before it. One save at a time, and a failed save keeps
 * the choices on screen to try again.
 */
export function IssueAccessWeighingPanel({
  personId,
  issueId,
  onClose,
  onSaved,
}: IssueAccessWeighingPanelProps): ReactElement {
  const { t } = useTranslation();
  const heading = usePanelHeadingFocus();
  const [weighing, setWeighing] = useState<IssueAccessWeighing | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [choices, setChoices] = useState<Record<string, Choice>>({});
  const [saving, setSaving] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);
  // A second click while a save is in flight must not send a second one.
  const inFlight = useRef(false);

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const loaded = await fetchIssueAccessWeighing(
          personId,
          issueId,
          controller.signal,
        );
        setWeighing(loaded);
        setChoices(
          Object.fromEntries(
            loaded.texts.flatMap((text) =>
              text.decision === null ? [] : [[keyOf(text), text.decision]],
            ),
          ),
        );
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") {
          return;
        }
        setLoadFailed(true);
      }
    })();
    return () => {
      controller.abort();
    };
  }, [personId, issueId, attempt]);

  const reasons =
    weighing?.report === "reporter"
      ? (["ABOUT_ANOTHER_PERSON"] as const)
      : ISSUE_ACCESS_WITHHOLDING_REASONS;
  const options: readonly Choice[] = ["given", ...reasons];
  const complete =
    weighing !== null &&
    weighing.texts.every((text) => choices[keyOf(text)] !== undefined);

  async function save(current: IssueAccessWeighing): Promise<void> {
    if (inFlight.current) {
      return;
    }
    inFlight.current = true;
    setSaving(true);
    setSaveFailed(false);
    try {
      await saveIssueAccessWeighing(
        personId,
        issueId,
        current.texts.map((text) => {
          const choice = choices[keyOf(text)];
          return {
            part: text.part,
            id: text.id,
            withheldBecause:
              choice === undefined || choice === "given" ? null : choice,
          };
        }),
      );
      onSaved();
    } catch (error) {
      // Not found: the issue left the report since it was produced (its record
      // was taken off, or its text removed). The report produced again says so.
      if (error instanceof RegisterRequestError && error.status === 404) {
        onSaved();
        return;
      }
      setSaveFailed(true);
    } finally {
      inFlight.current = false;
      setSaving(false);
    }
  }

  return (
    <section
      className={`${PANEL} flex flex-col gap-4 print:hidden`}
      aria-labelledby={`weighing-${issueId}`}
    >
      <h3
        id={`weighing-${issueId}`}
        ref={heading}
        tabIndex={-1}
        className="text-title"
      >
        {weighing === null
          ? t("register.person.report.weighing.headingLoading")
          : t("register.person.report.weighing.heading", {
              number: weighing.number,
              type: weighing.typeName,
            })}
      </h3>

      {loadFailed ? (
        <div className="flex flex-col items-start gap-3">
          <Notice tone="danger" live>
            {t("register.person.report.weighing.loadFailed")}
          </Notice>
          <button
            type="button"
            onClick={() => {
              setLoadFailed(false);
              setAttempt((previous) => previous + 1);
            }}
            className={SECONDARY_BUTTON}
          >
            {t("register.error.retry")}
          </button>
        </div>
      ) : weighing === null ? (
        <p role="status" className="text-body text-ink-muted">
          {t("register.person.report.weighing.loading")}
        </p>
      ) : (
        <>
          <p className="max-w-2xl text-body text-ink-muted">
            {t(
              weighing.report === "reporter"
                ? "register.person.report.weighing.intro.reporter"
                : "register.person.report.weighing.intro.concerned",
            )}
          </p>
          {weighing.texts.length === 0 ? (
            <p className="text-body text-ink-muted">
              {t("register.person.report.weighing.nothing")}
            </p>
          ) : (
            weighing.texts.map((text) => {
              const key = keyOf(text);
              return (
                <fieldset
                  key={key}
                  className="flex flex-col gap-2 border-t border-line pt-3"
                  disabled={saving}
                >
                  <legend className="text-label text-ink-muted uppercase">
                    {t(partLabel(text))}{" "}
                    <span className="font-data text-data normal-case">
                      {day(text.writtenAt)}
                    </span>
                  </legend>
                  <p className="max-w-2xl text-body whitespace-pre-line">
                    {text.text}
                  </p>
                  {options.map((option) => (
                    <label
                      key={option}
                      className="flex min-h-11 items-center gap-2 text-body"
                    >
                      <input
                        type="radio"
                        name={`weighing-${issueId}-${key}`}
                        value={option}
                        checked={choices[key] === option}
                        onChange={() => {
                          setChoices((previous) => ({
                            ...previous,
                            [key]: option,
                          }));
                          setSaveFailed(false);
                        }}
                        className="size-4"
                      />
                      {t(CHOICE_LABEL[option])}
                    </label>
                  ))}
                </fieldset>
              );
            })
          )}

          {saveFailed ? (
            <Notice tone="danger" live>
              {t("register.person.report.weighing.saveFailed")}
            </Notice>
          ) : null}
          {weighing.texts.length > 0 && !complete ? (
            <p className="text-small text-ink-muted">
              {t("register.person.report.weighing.chooseEach")}
            </p>
          ) : null}
        </>
      )}

      <div className="flex flex-wrap items-center gap-3">
        {weighing !== null && weighing.texts.length > 0 ? (
          <button
            type="button"
            onClick={() => {
              void save(weighing);
            }}
            disabled={!complete || saving}
            className={PRIMARY_BUTTON}
          >
            {t(
              saving
                ? "register.person.report.weighing.saving"
                : "register.person.report.weighing.save",
            )}
          </button>
        ) : null}
        <button type="button" onClick={onClose} className={SECONDARY_BUTTON}>
          {t("register.person.report.weighing.close")}
        </button>
      </div>
    </section>
  );
}

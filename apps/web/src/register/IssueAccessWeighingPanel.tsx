import {
  ISSUE_ACCESS_LEFT_OUT_MARK,
  type IssueAccessWithholdingReason,
  ISSUE_ACCESS_WITHHOLDING_REASONS,
  isGivenInPartOf,
} from "@openbrf/shared";
import { useEffect, useId, useRef, useState } from "react";
import type { TFunction } from "i18next";
import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";

import { localDayOfInstant } from "../bookings/booking-calendar";
import type { TranslationKey } from "../i18n/translation-key";
import {
  FIELD_MULTILINE,
  LABEL,
  PANEL,
  PRIMARY_BUTTON,
  SECONDARY_BUTTON,
} from "../ui/controls";
import { Notice } from "../ui/Notice";
import {
  type IssueAccessDecision,
  type IssueAccessWeighing,
  fetchIssueAccessWeighing,
} from "./register-api";
import { usePanelHeadingFocus } from "./use-panel-heading-focus";

/**
 * What the board chose for one text: give it whole, give it in part as a copy
 * with the words it must not give left out, or leave it out whole, each but
 * the first for a reason.
 */
type Choice =
  | { kind: "given" }
  | { kind: "inPart"; because: IssueAccessWithholdingReason; text: string }
  | { kind: "withheld"; because: IssueAccessWithholdingReason };

/** A choice as its radio names it: the kind, and for the last two the reason. */
type Option =
  | "given"
  | `inPart:${IssueAccessWithholdingReason}`
  | `withheld:${IssueAccessWithholdingReason}`;

type Text = IssueAccessWeighing["texts"][number];

/**
 * One text, by its part and, for a message, a note or a work order, its
 * identifier.
 */
function keyOf(text: Pick<Text, "part" | "id">): string {
  return `${text.part}:${text.id ?? ""}`;
}

function optionOf(choice: Choice | undefined): Option | undefined {
  if (choice === undefined || choice.kind === "given") {
    return choice?.kind;
  }
  return `${choice.kind}:${choice.because}`;
}

/** The weighing that stands for a text, as the panel offers it again. */
function standingChoice(text: Text): Choice | undefined {
  if (text.decision === null) {
    return undefined;
  }
  if (text.decision === "given") {
    return { kind: "given" };
  }
  return text.givenText === null
    ? { kind: "withheld", because: text.decision }
    : { kind: "inPart", because: text.decision, text: text.givenText };
}

/** Whether a choice can be saved: a copy given in part must only leave out. */
function settled(choice: Choice | undefined, text: Text): boolean {
  return (
    choice !== undefined &&
    (choice.kind !== "inPart" || isGivenInPartOf(choice.text, text.text))
  );
}

const PART_LABEL = {
  DESCRIPTION: "register.person.report.weighing.part.DESCRIPTION",
  LOCATION: "register.person.report.weighing.part.LOCATION",
  NOTE: "register.person.report.weighing.part.NOTE",
} as const satisfies Record<
  Exclude<Text["part"], "MESSAGE" | "WORK_ORDER">,
  TranslationKey
>;

const OPTION_LABEL = {
  given: "register.person.report.weighing.choice.given",
  "inPart:IDENTIFIES_REPORTER":
    "register.person.report.weighing.choice.inPart.IDENTIFIES_REPORTER",
  "inPart:ABOUT_ANOTHER_PERSON":
    "register.person.report.weighing.choice.inPart.ABOUT_ANOTHER_PERSON",
  "withheld:IDENTIFIES_REPORTER":
    "register.person.report.weighing.choice.withheld.IDENTIFIES_REPORTER",
  "withheld:ABOUT_ANOTHER_PERSON":
    "register.person.report.weighing.choice.withheld.ABOUT_ANOTHER_PERSON",
} as const satisfies Record<Option, TranslationKey>;

/**
 * What the text is, as its legend names it: a work order by whom it went to,
 * so the board can tell one from another, and a message by whose side wrote it.
 */
function partLabel(text: Text, t: TFunction): string {
  switch (text.part) {
    case "MESSAGE":
      return t(
        text.side === "HANDLER"
          ? "register.person.report.weighing.part.MESSAGE_HANDLER"
          : "register.person.report.weighing.part.MESSAGE_REPORTER",
      );
    case "WORK_ORDER":
      return text.recipientName === null
        ? t("register.person.report.weighing.part.WORK_ORDER_REMOVED")
        : t("register.person.report.weighing.part.WORK_ORDER", {
            recipient: text.recipientName,
          });
    default:
      return t(PART_LABEL[text.part]);
  }
}

/** The association's day of an instant, as the report states every date. */
function day(instant: string): string {
  return localDayOfInstant(instant);
}

export interface IssueAccessWeighingPanelProps {
  personId: string;
  issueId: string;
  /**
   * Whether a weighing for this report is being saved, from this panel or
   * one closed before it: one save at a time across the report.
   */
  saving: boolean;
  /**
   * Saves the weighing, replacing the one before it, and answers whether it
   * was saved. The report owns the save, so a save outlives the panel that
   * sent it and never acts on a panel opened after it.
   */
  onSave: (decisions: IssueAccessDecision[]) => Promise<boolean>;
  onClose: () => void;
}

/**
 * The board's weighing under GDPR art. 15(4) of one issue's texts for one
 * person's access report (ADR 0057).
 *
 * On the board's screen and never on the paper: it shows the words the report
 * may leave out, so the board can weigh them. Each text is given whole, given
 * in part, or left out whole, for a stated reason. To give it in part the
 * board takes the words it must not give out of a copy of it, each place
 * marked, and the report prints that copy and the reason; the text itself
 * stays as written. The report never prints a word left out. A reporter's own
 * report weighs only the internal notes and the work orders' text, and never
 * leaves anything out for telling them who reported their own case.
 *
 * Saved whole: every text the panel shows needs a choice, and the save
 * replaces the weighing before it. A failed save keeps the choices on screen
 * to try again.
 */
export function IssueAccessWeighingPanel({
  personId,
  issueId,
  saving,
  onSave,
  onClose,
}: IssueAccessWeighingPanelProps): ReactElement {
  const { t } = useTranslation();
  const heading = usePanelHeadingFocus();
  const [weighing, setWeighing] = useState<IssueAccessWeighing | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [choices, setChoices] = useState<Record<string, Choice>>({});
  const [saveFailed, setSaveFailed] = useState(false);

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
            loaded.texts.flatMap((text) => {
              const choice = standingChoice(text);
              return choice === undefined ? [] : [[keyOf(text), choice]];
            }),
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
  const options: readonly Option[] = [
    "given",
    ...reasons.map((reason) => `inPart:${reason}` as const),
    ...reasons.map((reason) => `withheld:${reason}` as const),
  ];
  const complete =
    weighing !== null &&
    weighing.texts.every((text) => settled(choices[keyOf(text)], text));

  function choose(text: Text, option: Option): void {
    const key = keyOf(text);
    setChoices((previous) => {
      const before = previous[key];
      let next: Choice;
      if (option === "given") {
        next = { kind: "given" };
      } else {
        const [kind, because] = option.split(":") as [
          "inPart" | "withheld",
          IssueAccessWithholdingReason,
        ];
        next =
          kind === "withheld"
            ? { kind, because }
            : {
                kind,
                because,
                // A copy already begun is kept when only the reason changes;
                // a new one starts as the whole text, to take words out of.
                text: before?.kind === "inPart" ? before.text : text.text,
              };
      }
      return { ...previous, [key]: next };
    });
    setSaveFailed(false);
  }

  function editCopy(text: Text, copy: string): void {
    const key = keyOf(text);
    setChoices((previous) => {
      const before = previous[key];
      return before?.kind === "inPart"
        ? { ...previous, [key]: { ...before, text: copy } }
        : previous;
    });
    setSaveFailed(false);
  }

  async function save(current: IssueAccessWeighing): Promise<void> {
    setSaveFailed(false);
    const saved = await onSave(
      current.texts.map((text) => {
        const choice = choices[keyOf(text)];
        return {
          part: text.part,
          id: text.id,
          withheldBecause:
            choice === undefined || choice.kind === "given"
              ? null
              : choice.because,
          givenText: choice?.kind === "inPart" ? choice.text : null,
        };
      }),
    );
    if (!saved) {
      setSaveFailed(true);
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
              const choice = choices[key];
              return (
                <fieldset
                  key={key}
                  className="flex flex-col gap-2 border-t border-line pt-3"
                  disabled={saving}
                >
                  <legend className="text-label text-ink-muted uppercase">
                    {partLabel(text, t)}{" "}
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
                        checked={optionOf(choice) === option}
                        onChange={() => {
                          choose(text, option);
                        }}
                        className="size-4"
                      />
                      {t(OPTION_LABEL[option])}
                    </label>
                  ))}
                  {choice?.kind === "inPart" ? (
                    <PartialCopy
                      copy={choice.text}
                      original={text.text}
                      onChange={(copy) => {
                        editCopy(text, copy);
                      }}
                    />
                  ) : null}
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

/**
 * The copy of a text the report gives in part. It starts as the whole text;
 * the board selects the words the report must not give and leaves them out,
 * and each place is marked `ISSUE_ACCESS_LEFT_OUT_MARK`. Typing in it is
 * allowed, but a copy that adds or moves a word is not saved
 * (`isGivenInPartOf`), so the report never gives words the case does not hold.
 */
function PartialCopy({
  copy,
  original,
  onChange,
}: {
  copy: string;
  original: string;
  onChange: (copy: string) => void;
}): ReactElement {
  const { t } = useTranslation();
  const field = useRef<HTMLTextAreaElement>(null);
  const id = useId();
  const valid = isGivenInPartOf(copy, original);

  function leaveOutSelection(): void {
    const area = field.current;
    if (area === null || area.selectionStart === area.selectionEnd) {
      area?.focus();
      return;
    }
    const start = area.selectionStart;
    const next =
      copy.slice(0, start) +
      ISSUE_ACCESS_LEFT_OUT_MARK +
      copy.slice(area.selectionEnd);
    onChange(next);
    // Back to the copy, just after the mark, for the next words to go.
    requestAnimationFrame(() => {
      area.focus();
      const caret = start + ISSUE_ACCESS_LEFT_OUT_MARK.length;
      area.setSelectionRange(caret, caret);
    });
  }

  return (
    <div className="flex flex-col gap-2">
      <label className={LABEL} htmlFor={`${id}-copy`}>
        {t("register.person.report.weighing.copy.label")}
      </label>
      <p id={`${id}-hint`} className="max-w-2xl text-small text-ink-muted">
        {t("register.person.report.weighing.copy.hint", {
          mark: ISSUE_ACCESS_LEFT_OUT_MARK,
        })}
      </p>
      <textarea
        id={`${id}-copy`}
        ref={field}
        value={copy}
        rows={4}
        aria-invalid={!valid}
        aria-describedby={valid ? `${id}-hint` : `${id}-hint ${id}-invalid`}
        onChange={(event) => {
          onChange(event.target.value);
        }}
        className={`${FIELD_MULTILINE} max-w-2xl`}
      />
      {valid ? null : (
        <p id={`${id}-invalid`} className="max-w-2xl text-small text-danger">
          {t("register.person.report.weighing.copy.invalid", {
            mark: ISSUE_ACCESS_LEFT_OUT_MARK,
          })}
        </p>
      )}
      <div>
        <button
          type="button"
          // Keeps the selection in the copy: a click would otherwise move focus
          // before the words are read.
          onMouseDown={(event) => {
            event.preventDefault();
          }}
          onClick={leaveOutSelection}
          className={SECONDARY_BUTTON}
        >
          {t("register.person.report.weighing.copy.leaveOut")}
        </button>
      </div>
    </div>
  );
}

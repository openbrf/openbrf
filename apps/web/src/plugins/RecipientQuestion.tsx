import { scanForPersonalIdentityNumbers } from "@openbrf/shared";
import { useId, type ReactElement } from "react";
import { useTranslation } from "react-i18next";

import type { TranslationKey } from "../i18n/translation-key";
import { FIELD, HINT, LABEL } from "../ui/controls";
import { Notice } from "../ui/Notice";
import type { ProcessorAgreementAnswer } from "./plugin-api";

/** What a recipient outside the instance can be. */
type OutsideClassification = "PROCESSOR" | "INDEPENDENT_CONTROLLER";

/**
 * The question as the board is filling it in.
 *
 * Every part starts unanswered, including the first, and none is ever filled
 * in on the board's behalf. The catalog entry carries no statement about where
 * a plugin sends personal data - its personal-data declaration is what the
 * plugin handles, "a declaration, not an enforcement point", and a plugin runs
 * at full process privilege (ADR 0003) - so there is nothing for a default to
 * be read from. The art. 28 record agrees: it suggests a classification for
 * the association's own disk and for a connected app, whose facts settle one,
 * and none for a plugin. A pre-selected "no" would be the instance answering
 * the one question it cannot answer, and it would write "passes no personal
 * data on" into the record on the strength of a click.
 */
export interface RecipientDraft {
  sendsOutside: boolean | null;
  recipient: string;
  classification: OutsideClassification | null;
  note: string;
}

export const UNANSWERED: RecipientDraft = {
  sendsOutside: null,
  recipient: "",
  classification: null,
  note: "",
};

/** The API refuses one in anything the board wrote into the record. */
function carriesIdentityNumber(text: string): boolean {
  return scanForPersonalIdentityNumbers(text).length > 0;
}

/**
 * The answer the install request carries, or null while it is incomplete.
 *
 * Complete once it says what the record needs: a recipient for "yes" (art.
 * 30(1)(d) asks who receives the data), which kind of recipient it is, a reason
 * for an independent controller, and no personal identity number in what was
 * typed. The API would record an unstated kind as a processor, which is the
 * board's call rather than the screen's, and it refuses a missing reason or an
 * identity number only after it has written the consent row - so an answer it
 * would refuse there is one the screen must not send.
 *
 * Only what the answer on screen says is sent. A recipient typed under "yes"
 * and then answered "no" stays in the fields in case the board changes its mind
 * again, and does not travel.
 */
export function recipientAnswer(
  draft: RecipientDraft,
): ProcessorAgreementAnswer | null {
  if (draft.sendsOutside === null) {
    return null;
  }
  if (!draft.sendsOutside) {
    return { sendsPersonalDataOutside: false };
  }

  const recipient = draft.recipient.trim();
  if (recipient === "" || carriesIdentityNumber(recipient)) {
    return null;
  }
  if (draft.classification === "PROCESSOR") {
    return {
      sendsPersonalDataOutside: true,
      recipient,
      classification: "PROCESSOR",
    };
  }
  if (draft.classification === "INDEPENDENT_CONTROLLER") {
    const note = draft.note.trim();
    if (note === "" || carriesIdentityNumber(note)) {
      return null;
    }
    return {
      sendsPersonalDataOutside: true,
      recipient,
      classification: "INDEPENDENT_CONTROLLER",
      note,
    };
  }
  return null;
}

/**
 * The two classifications, named as the data protection screen names them.
 *
 * The record's own words rather than a second set: this step writes the same
 * row that screen classifies, and a board reading "processor" here and
 * something else there would be reading two records.
 */
const CLASSIFICATIONS: readonly {
  value: OutsideClassification;
  label: TranslationKey;
  hint: TranslationKey;
}[] = [
  {
    value: "PROCESSOR",
    label: "dataProtection.processors.state.processor",
    hint: "plugins.consent.recipient.processorHint",
  },
  {
    value: "INDEPENDENT_CONTROLLER",
    label: "dataProtection.processors.state.independentController",
    hint: "plugins.consent.recipient.independentControllerHint",
  },
];

export interface RecipientQuestionProps {
  draft: RecipientDraft;
  onChange: (draft: RecipientDraft) => void;
  disabled?: boolean;
}

/**
 * Whether the plugin sends personal data outside the instance, and to whom.
 *
 * The one question on the consent step the catalog cannot answer
 * (docs/plugin-contract.md, "Where the plugin sends personal data"). "No"
 * records the plugin as a recipient that is no processor. "Yes" names the
 * recipient and asks which kind it is: a processor, whose agreement is then
 * recorded as being made until the board records it on the data protection
 * screen, or an independent controller, for which the record keeps the reason
 * no agreement is needed.
 */
export function RecipientQuestion({
  draft,
  onChange,
  disabled = false,
}: RecipientQuestionProps): ReactElement {
  const { t } = useTranslation();
  const introId = useId();
  const recipientHintId = useId();
  const hintIdPrefix = useId();
  const warningId = useId();

  const update = (change: Partial<RecipientDraft>): void => {
    onChange({ ...draft, ...change });
  };

  /*
   * Per field, so the one holding the number is the one marked invalid. The
   * reason counts only where it is asked for: a note typed under an independent
   * controller and left behind by switching to a processor is not sent.
   */
  const recipientInvalid = carriesIdentityNumber(draft.recipient);
  const noteInvalid =
    draft.classification === "INDEPENDENT_CONTROLLER" &&
    carriesIdentityNumber(draft.note);
  const identityNumberTyped = recipientInvalid || noteInvalid;

  /** Marks a field invalid and names the warning, or says nothing. */
  const invalidAttributes = (
    invalid: boolean,
  ): { "aria-invalid"?: true; "aria-errormessage"?: string } =>
    invalid ? { "aria-invalid": true, "aria-errormessage": warningId } : {};

  return (
    <section className="flex flex-col gap-3">
      <h3 className="text-label text-ink-muted uppercase">
        {t("plugins.consent.recipient.title")}
      </h3>
      <p id={introId} className={HINT}>
        {t("plugins.consent.recipient.intro")}
      </p>

      <fieldset
        className="flex flex-col gap-1"
        aria-describedby={introId}
        disabled={disabled}
      >
        <legend className="mb-1 text-body text-ink">
          {t("plugins.consent.recipient.question")}
        </legend>
        {([false, true] as const).map((answer) => (
          <label
            key={String(answer)}
            className="flex min-h-11 items-center gap-3 text-small text-ink"
          >
            <input
              type="radio"
              name="sends-personal-data-outside"
              required
              checked={draft.sendsOutside === answer}
              onChange={() => {
                update({ sendsOutside: answer });
              }}
              className="size-4 accent-trust"
            />
            {t(
              answer
                ? "plugins.consent.recipient.yes"
                : "plugins.consent.recipient.no",
            )}
          </label>
        ))}
      </fieldset>

      {draft.sendsOutside === true ? (
        <div className="flex flex-col gap-3 border-l-2 border-line-strong pl-3">
          <div className="flex flex-col gap-1">
            <label className="flex flex-col gap-1">
              <span className={LABEL}>
                {t("plugins.consent.recipient.recipient")}
              </span>
              <input
                className={FIELD}
                value={draft.recipient}
                required
                maxLength={200}
                autoComplete="off"
                disabled={disabled}
                aria-describedby={recipientHintId}
                {...invalidAttributes(recipientInvalid)}
                onChange={(event) => {
                  update({ recipient: event.target.value });
                }}
              />
            </label>
            <p id={recipientHintId} className={HINT}>
              {t("plugins.consent.recipient.recipientHint")}
            </p>
          </div>

          <fieldset className="flex flex-col gap-1" disabled={disabled}>
            <legend className={`mb-1 ${LABEL}`}>
              {t("dataProtection.processors.classification")}
            </legend>
            {CLASSIFICATIONS.map((option) => {
              const hintId = `${hintIdPrefix}-${option.value}`;
              return (
                <div key={option.value} className="flex flex-col">
                  <label className="flex min-h-11 items-center gap-3 text-small text-ink">
                    <input
                      type="radio"
                      name="recipient-classification"
                      required
                      checked={draft.classification === option.value}
                      aria-describedby={hintId}
                      onChange={() => {
                        update({ classification: option.value });
                      }}
                      className="size-4 accent-trust"
                    />
                    {t(option.label)}
                  </label>
                  <p id={hintId} className={`${HINT} pl-7`}>
                    {t(option.hint)}
                  </p>
                </div>
              );
            })}
          </fieldset>

          {draft.classification === "INDEPENDENT_CONTROLLER" ? (
            <label className="flex flex-col gap-1">
              <span className={LABEL}>
                {t("dataProtection.processors.note")}
              </span>
              <textarea
                className={FIELD}
                rows={2}
                value={draft.note}
                required
                maxLength={1000}
                disabled={disabled}
                {...invalidAttributes(noteInvalid)}
                onChange={(event) => {
                  update({ note: event.target.value });
                }}
              />
            </label>
          ) : null}

          {/*
            The live region is mounted with the fields and stays, and only the
            warning inside it comes and goes: a status region inserted together
            with its message can stay silent (see Notice), and this warning is
            not a failure that earns an alert. The Notice inside is therefore not
            live itself, which would nest one region in another. Empty, it takes
            no room: the negative margin cancels the gap above it.
          */}
          <div
            id={warningId}
            role="status"
            aria-live="polite"
            className="empty:-mt-3"
          >
            {identityNumberTyped ? (
              <Notice tone="warn">
                {t("dataProtection.processors.errors.personalIdentityNumber")}
              </Notice>
            ) : null}
          </div>
        </div>
      ) : null}
    </section>
  );
}

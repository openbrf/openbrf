import {
  ISSUE_DAMAGE_CASE_LIMITS,
  ISSUE_DAMAGE_CAUSES,
  type IssueDamageCause,
} from "@openbrf/shared";
import { useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";

import type { ApiFailure } from "../api/client";
import {
  type IssueDamageCase,
  markIssueDamageCase,
  type QueuedIssue,
  removeIssueDamageCase,
} from "../api/issues";
import type { TranslationKey } from "../i18n/translation-key";
import {
  FIELD,
  FIELD_DATA,
  HINT,
  LABEL,
  QUIET_BUTTON,
  SECONDARY_BUTTON,
} from "../ui/controls";
import { Notice } from "../ui/Notice";
import { failureMessageKey, useSaveAction } from "../ui/save-state";
import { ISSUE_DAMAGE_CAUSE_LABEL } from "./issue-labels";

const DAMAGE_CASE_FAILURES: Readonly<Record<string, TranslationKey>> = {
  "damage-case-incomplete": "issues.damageCase.errors.incomplete",
  "personal-identity-number": "issues.damageCase.errors.identityNumber",
  "damage-date-invalid": "issues.damageCase.errors.dateInvalid",
  "damage-case-changed": "issues.damageCase.errors.changed",
  "issue-not-found": "issues.damageCase.errors.notFound",
  "invalid-body": "issues.damageCase.errors.incomplete",
};

const EMPTY: IssueDamageCase = {
  insurer: "",
  claimNumber: "",
  occurredOn: "",
  cause: "WATER",
};

/**
 * Whether an issue is an insurance damage (skadeärende, decision 28), and the
 * form that marks it, changes the mark or takes it off.
 *
 * Marking it places a legal hold on the issue, which the section below this
 * one shows and releases: the hint says so, and taking the mark off leaves the
 * hold. The draft starts from the issue's mark as it was read, and a save
 * says which mark that was: the API refuses a save made from a mark that
 * another handler has changed or taken off since, so neither is written over
 * the other unseen. A re-read that brings another mark replaces a draft nobody
 * has touched; one the handler is editing stays, with a notice that the mark
 * changed and a way to take the current one, and cannot be saved or taken off until then.
 *
 * One write at a time: both buttons wait on a write in flight, and an edit
 * clears the outcome of the last one, which no longer describes the draft.
 */
export function IssueDamageCaseSection({
  issue,
  onChanged,
}: {
  issue: QueuedIssue;
  onChanged: () => void;
}): ReactElement {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<IssueDamageCase>(
    issue.damageCase ?? EMPTY,
  );
  /** The mark the draft started from, which an edit does not move. */
  const [base, setBase] = useState<IssueDamageCase | null>(issue.damageCase);
  const current = issue.damageCase;
  if (!sameCase(base, current)) {
    if (sameCase(draft, base ?? EMPTY)) {
      // Nobody has touched the draft: it follows the mark.
      setBase(current);
      setDraft(current ?? EMPTY);
    } else if (sameCase(written(draft), current ?? EMPTY)) {
      // The draft is what was saved, which is now the mark.
      setBase(current);
    }
  }
  /** Whether the mark is another than the one the edited draft began from. */
  const behind = !sameCase(base, current);
  /** What the last write did, while the draft is still the one it wrote. */
  const [outcome, setOutcome] = useState<"saved" | "removed" | null>(null);
  /** A refusal because the mark moved is the cue to re-read it. */
  const reread = (failure: ApiFailure): void => {
    if (failure.reason === "damage-case-changed") {
      onChanged();
    }
  };
  const mark = useSaveAction(
    markIssueDamageCase,
    () => {
      setOutcome("saved");
      onChanged();
    },
    reread,
  );
  const remove = useSaveAction(
    removeIssueDamageCase,
    () => {
      setOutcome("removed");
      onChanged();
    },
    reread,
  );
  const busy = mark.pending || remove.pending;
  const takeCurrent = (): void => {
    setBase(current);
    setDraft(current ?? EMPTY);
    setOutcome(null);
    mark.reset();
    remove.reset();
  };
  const failed =
    mark.state.kind === "failed"
      ? mark.state.failure
      : remove.state.kind === "failed"
        ? remove.state.failure
        : null;

  const edit = (change: Partial<IssueDamageCase>): void => {
    setDraft({ ...draft, ...change });
    setOutcome(null);
    mark.reset();
    remove.reset();
  };
  const ready =
    !behind &&
    draft.insurer.trim() !== "" &&
    draft.claimNumber.trim() !== "" &&
    draft.occurredOn !== "";
  const marked = issue.damageCase !== null;
  const named = { number: issue.number };

  return (
    <section className="flex flex-col gap-3">
      <h3 className="text-label text-ink-muted uppercase">
        {t("issues.damageCase.title")}
      </h3>
      <p className={HINT}>{t("issues.damageCase.hint")}</p>
      {failed === null ? null : (
        <Notice tone="danger" live>
          {t(
            failureMessageKey(
              failed,
              DAMAGE_CASE_FAILURES,
              "issues.damageCase.errors.unknown",
            ),
          )}
        </Notice>
      )}
      {behind ? (
        <Notice tone="warn" live>
          <p>{t("issues.damageCase.changedMeanwhile")}</p>
          <button
            type="button"
            disabled={busy}
            onClick={takeCurrent}
            className={QUIET_BUTTON}
          >
            {t("issues.damageCase.takeCurrent")}
          </button>
        </Notice>
      ) : null}
      {outcome === null ? null : (
        <Notice tone="ok" live>
          {t(
            outcome === "saved"
              ? "issues.damageCase.saved"
              : "issues.damageCase.removed",
          )}
        </Notice>
      )}
      <form
        className="flex flex-wrap items-end gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (!ready || busy) {
            return;
          }
          void mark.submit({
            issueId: issue.id,
            damageCase: written(draft),
            replaces: base,
          });
        }}
      >
        <label className={`${LABEL} min-w-56`}>
          {t("issues.damageCase.insurer")}
          <input
            type="text"
            name="damageInsurer"
            autoComplete="organization"
            maxLength={ISSUE_DAMAGE_CASE_LIMITS.insurer}
            value={draft.insurer}
            onChange={(event) => {
              edit({ insurer: event.target.value });
            }}
            className={FIELD}
          />
        </label>
        <label className={`${LABEL} min-w-40`}>
          {t("issues.damageCase.claimNumber")}
          <input
            type="text"
            name="damageClaimNumber"
            autoComplete="off"
            maxLength={ISSUE_DAMAGE_CASE_LIMITS.claimNumber}
            value={draft.claimNumber}
            onChange={(event) => {
              edit({ claimNumber: event.target.value });
            }}
            className={FIELD_DATA}
          />
        </label>
        <label className={`${LABEL} min-w-40`}>
          {t("issues.damageCase.occurredOn")}
          <input
            type="date"
            name="damageOccurredOn"
            value={draft.occurredOn}
            onChange={(event) => {
              edit({ occurredOn: event.target.value });
            }}
            className={FIELD_DATA}
          />
        </label>
        <label className={`${LABEL} min-w-48`}>
          {t("issues.damageCase.cause")}
          <select
            name="damageCause"
            value={draft.cause}
            onChange={(event) => {
              edit({ cause: event.target.value as IssueDamageCause });
            }}
            className={FIELD}
          >
            {ISSUE_DAMAGE_CAUSES.map((cause) => (
              <option key={cause} value={cause}>
                {t(ISSUE_DAMAGE_CAUSE_LABEL[cause])}
              </option>
            ))}
          </select>
        </label>
        <button
          type="submit"
          disabled={!ready || busy}
          aria-label={
            marked
              ? t("issues.damageCase.saveNamed", named)
              : t("issues.damageCase.markNamed", named)
          }
          className={SECONDARY_BUTTON}
        >
          {mark.state.kind === "saving"
            ? t("issues.damageCase.saving")
            : marked
              ? t("issues.damageCase.save")
              : t("issues.damageCase.mark")}
        </button>
        {marked ? (
          <button
            type="button"
            disabled={busy || behind || base === null}
            aria-label={t("issues.damageCase.removeNamed", named)}
            onClick={() => {
              if (base === null) {
                return;
              }
              void remove.submit({ issueId: issue.id, replaces: base });
            }}
            className={QUIET_BUTTON}
          >
            {remove.state.kind === "saving"
              ? t("issues.damageCase.removing")
              : t("issues.damageCase.remove")}
          </button>
        ) : null}
      </form>
    </section>
  );
}

/** The draft as a save writes it: the insurer and the number trimmed. */
function written(draft: IssueDamageCase): IssueDamageCase {
  return {
    insurer: draft.insurer.trim(),
    claimNumber: draft.claimNumber.trim(),
    occurredOn: draft.occurredOn,
    cause: draft.cause,
  };
}

function sameCase(
  a: IssueDamageCase | null,
  b: IssueDamageCase | null,
): boolean {
  return (
    a === b ||
    (a !== null &&
      b !== null &&
      a.insurer === b.insurer &&
      a.claimNumber === b.claimNumber &&
      a.occurredOn === b.occurredOn &&
      a.cause === b.cause)
  );
}

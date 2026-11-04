import {
  ISSUE_DAMAGE_CASE_LIMITS,
  ISSUE_DAMAGE_CAUSES,
  type IssueDamageCause,
} from "@openbrf/shared";
import { useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";

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
 * hold. The draft starts from the issue's mark as it was read. A re-read that
 * brings another mark - somebody else changed it - replaces a draft nobody has
 * touched, and leaves one the handler is editing alone, so neither is saved
 * over the other unseen.
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
  /** The mark the draft started from, as the queue last read it. */
  const [basis, setBasis] = useState<IssueDamageCase | null>(issue.damageCase);
  if (!sameCase(basis, issue.damageCase)) {
    setBasis(issue.damageCase);
    if (sameCase(draft, basis ?? EMPTY)) {
      setDraft(issue.damageCase ?? EMPTY);
    }
  }
  /** What the last write did, while the draft is still the one it wrote. */
  const [outcome, setOutcome] = useState<"saved" | "removed" | null>(null);
  const mark = useSaveAction(markIssueDamageCase, () => {
    setOutcome("saved");
    onChanged();
  });
  const remove = useSaveAction(removeIssueDamageCase, () => {
    setOutcome("removed");
    onChanged();
  });
  const busy = mark.pending || remove.pending;
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
            damageCase: {
              insurer: draft.insurer.trim(),
              claimNumber: draft.claimNumber.trim(),
              occurredOn: draft.occurredOn,
              cause: draft.cause,
            },
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
            disabled={busy}
            aria-label={t("issues.damageCase.removeNamed", named)}
            onClick={() => {
              void remove.submit({ issueId: issue.id });
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

import { ISSUE_KNOWN_FAULT_LIMITS } from "@openbrf/shared";
import { useEffect, useId, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";

import {
  fetchIssueLinks,
  type IssueLinks,
  type IssueReference,
  mergeIssue,
  publishKnownFault,
  type QueuedIssue,
  sendToDuplicateReporters,
  withdrawKnownFault,
} from "../api/issues";
import { localDayOfInstant } from "../bookings/booking-calendar";
import type { TranslationKey } from "../i18n/translation-key";
import {
  FIELD,
  FIELD_MULTILINE,
  HINT,
  LABEL,
  PRIMARY_BUTTON,
  SECONDARY_BUTTON,
} from "../ui/controls";
import { Notice } from "../ui/Notice";
import { failureMessageKey, useSaveAction } from "../ui/save-state";
import { TwoPressConfirm } from "../ui/TwoPressConfirm";
import { ConversationComposer } from "./ConversationComposer";
import { IssueStatusChip } from "./IssueStatusChip";

const LIFECYCLE_FAILURES: Readonly<Record<string, TranslationKey>> = {
  "issue-not-found": "issues.lifecycle.errors.issueNotFound",
  "issue-closed": "issues.lifecycle.errors.issueClosed",
  "known-fault-board-only": "issues.lifecycle.errors.knownFaultBoardOnly",
  "merge-into-itself": "issues.lifecycle.errors.mergeIntoItself",
  "merge-into-duplicate": "issues.lifecycle.errors.mergeIntoDuplicate",
  "merge-has-duplicates": "issues.lifecycle.errors.mergeHasDuplicates",
  "merge-into-closed": "issues.lifecycle.errors.mergeIntoClosed",
  "personal-identity-number": "issues.lifecycle.errors.personalIdentityNumber",
  "invalid-body": "issues.lifecycle.errors.unknown",
};

const DUPLICATE_MESSAGE_FAILURES: Readonly<Record<string, TranslationKey>> = {
  "issue-not-found": "issues.conversation.errors.issueNotFoundHandler",
  "no-reporter": "issues.lifecycle.errors.noDuplicateReporter",
  "personal-identity-number":
    "issues.conversation.errors.personalIdentityNumber",
  "invalid-body": "issues.conversation.errors.unknown",
};

/** The refusals that mean the queue on screen is out of date. */
const STALE_REASONS: ReadonlySet<string> = new Set([
  "issue-not-found",
  "issue-closed",
  "merge-into-duplicate",
  "merge-has-duplicates",
  "merge-into-closed",
  "known-fault-board-only",
]);

/**
 * What happens to an issue beside its handling (decisions 8 and 22): its known
 * fault, the issues it is linked to, merging it into another as a duplicate,
 * and a message to every reporter of the issues merged into it.
 *
 * Read only while the issue is open on screen, as its handling is. The links
 * are read again whenever the queue brings a newer revision of the issue, and
 * every save here reads the queue again.
 */
export function IssueLifecycle({
  issue,
  candidates,
  onChanged,
}: {
  issue: QueuedIssue;
  /** The other issues on screen, which this one may be merged into. */
  candidates: readonly QueuedIssue[];
  onChanged: () => void;
}): ReactElement {
  const { t } = useTranslation();
  const [links, setLinks] = useState<IssueLinks | null>(null);
  const [readFailed, setReadFailed] = useState(false);
  const [reads, setReads] = useState(0);
  const revision = `${issue.updatedAt}:${issue.status.id}`;
  /*
   * Every change made here may change the links - an issue merged into this
   * one, a refusal that says it was - and merging another issue into this one
   * moves nothing of this issue the queue would show, so they are read again
   * whenever the queue is.
   */
  const changed = (): void => {
    setReads((count) => count + 1);
    onChanged();
  };

  useEffect(() => {
    let active = true;
    void fetchIssueLinks(issue.id).then((read) => {
      if (!active) {
        return;
      }
      if (read.ok) {
        setLinks(read.value);
        setReadFailed(false);
      } else {
        setReadFailed(true);
      }
    });
    return () => {
      active = false;
    };
  }, [issue.id, revision, reads]);

  return (
    <div className="flex flex-col gap-4">
      {readFailed ? (
        <Notice tone="danger" live>
          {t("issues.lifecycle.readFailed")}
        </Notice>
      ) : null}

      <KnownFaultForm
        // Mounted again when the notice changes, so the draft starts from it.
        key={`known:${issue.knownFault?.body ?? ""}`}
        issue={issue}
        onChanged={changed}
      />

      {links === null ? null : <LinksSection links={links} />}

      {links !== null && links.duplicates.length > 0 ? (
        <section className="flex flex-col gap-2">
          <h3 className="text-label text-ink-muted uppercase">
            {t("issues.lifecycle.toDuplicatesTitle")}
          </h3>
          <ConversationComposer
            label={t("issues.lifecycle.toDuplicates")}
            ariaLabel={t("issues.lifecycle.toDuplicatesNamed", {
              type: issue.typeName,
            })}
            hint={t("issues.lifecycle.toDuplicatesHint", {
              count: links.duplicates.length,
            })}
            sendLabel={t("issues.conversation.send")}
            sendingLabel={t("issues.conversation.sending")}
            failures={DUPLICATE_MESSAGE_FAILURES}
            fallback="issues.conversation.errors.unknown"
            send={(body) =>
              sendToDuplicateReporters({ issueId: issue.id, body })
            }
            onSent={() => undefined}
          />
        </section>
      ) : null}

      {links !== null &&
      issue.outcome !== "DUPLICATE" &&
      links.duplicates.length === 0 ? (
        <MergeForm issue={issue} candidates={candidates} onChanged={changed} />
      ) : null}
    </div>
  );
}

/**
 * The issue's known fault: written, rewritten or withdrawn by a handler,
 * shown to signed-in residents and on their report form, never on the public
 * website. Not offered on an issue that is done, or one the board keeps to
 * itself, both of which the server refuses too.
 */
function KnownFaultForm({
  issue,
  onChanged,
}: {
  issue: QueuedIssue;
  onChanged: () => void;
}): ReactElement | null {
  const { t } = useTranslation();
  const fieldId = useId();
  const hintId = useId();
  const published = issue.knownFault;
  const [draft, setDraft] = useState(published?.body ?? "");
  const onFailed = (failure: { reason: string }): void => {
    if (STALE_REASONS.has(failure.reason)) {
      onChanged();
    }
  };
  const publish = useSaveAction(
    (body: string) => publishKnownFault({ issueId: issue.id, body }),
    onChanged,
    onFailed,
  );
  const withdraw = useSaveAction(
    () => withdrawKnownFault(issue.id),
    onChanged,
    onFailed,
  );
  const busy =
    publish.state.kind === "saving" || withdraw.state.kind === "saving";

  if (issue.meaning === "DONE") {
    return null;
  }
  if (issue.boardOnly || issue.typeHandledBy === "BOARD") {
    return (
      <section className="flex flex-col gap-1">
        <h3 className="text-label text-ink-muted uppercase">
          {t("issues.knownFault.label")}
        </h3>
        <p className={HINT}>{t("issues.lifecycle.knownFaultBoardOnly")}</p>
      </section>
    );
  }

  const failed =
    publish.state.kind === "failed"
      ? publish.state.failure
      : withdraw.state.kind === "failed"
        ? withdraw.state.failure
        : null;
  const trimmed = draft.trim();
  const unchanged = trimmed === (published?.body ?? "");

  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-label text-ink-muted uppercase">
        {t("issues.knownFault.label")}
      </h3>
      {failed === null ? null : (
        <Notice tone="danger" live>
          {t(
            failureMessageKey(
              failed,
              LIFECYCLE_FAILURES,
              "issues.lifecycle.errors.unknown",
            ),
          )}
        </Notice>
      )}
      <form
        className="flex flex-col gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (!busy && trimmed !== "" && !unchanged) {
            void publish.submit(trimmed);
          }
        }}
      >
        <label className={LABEL} htmlFor={fieldId}>
          {t("issues.lifecycle.knownFaultField")}
        </label>
        <textarea
          id={fieldId}
          aria-label={t("issues.lifecycle.knownFaultNamed", {
            type: issue.typeName,
          })}
          aria-describedby={hintId}
          rows={3}
          maxLength={ISSUE_KNOWN_FAULT_LIMITS.body}
          value={draft}
          disabled={busy}
          onChange={(event) => {
            setDraft(event.target.value);
            if (publish.state.kind === "failed") {
              publish.reset();
            }
            if (withdraw.state.kind === "failed") {
              withdraw.reset();
            }
          }}
          className={FIELD_MULTILINE}
        />
        <p id={hintId} className={HINT}>
          {t("issues.lifecycle.knownFaultHint")}
        </p>
        <div className="flex flex-wrap gap-2">
          <button
            type="submit"
            disabled={busy || trimmed === "" || unchanged}
            className={PRIMARY_BUTTON}
          >
            {publish.state.kind === "saving"
              ? t("issues.lifecycle.knownFaultPublishing")
              : published === null
                ? t("issues.lifecycle.knownFaultPublish")
                : t("issues.lifecycle.knownFaultRewrite")}
          </button>
          {published === null ? null : (
            <button
              type="button"
              disabled={busy}
              className={SECONDARY_BUTTON}
              onClick={() => {
                void withdraw.submit();
              }}
            >
              {t("issues.lifecycle.knownFaultWithdraw")}
            </button>
          )}
        </div>
      </form>
    </section>
  );
}

/** The issues this one is linked to, by type, day and where each stands. */
function LinksSection({ links }: { links: IssueLinks }): ReactElement | null {
  const { t } = useTranslation();
  const rows: { key: string; label: string; reference: IssueReference }[] = [
    ...(links.mergedInto === null
      ? []
      : [
          {
            key: "merged-into",
            label: t("issues.lifecycle.mergedInto"),
            reference: links.mergedInto,
          },
        ]),
    ...links.duplicates.map((reference) => ({
      key: `duplicate-${reference.id}`,
      label: t("issues.lifecycle.duplicate"),
      reference,
    })),
    ...(links.follows === null
      ? []
      : [
          {
            key: "follows",
            label: t("issues.lifecycle.follows"),
            reference: links.follows,
          },
        ]),
    ...links.followUps.map((reference) => ({
      key: `follow-up-${reference.id}`,
      label: t("issues.lifecycle.followUp"),
      reference,
    })),
  ];
  if (rows.length === 0) {
    return null;
  }
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-label text-ink-muted uppercase">
        {t("issues.lifecycle.linksTitle")}
      </h3>
      <ul className="flex flex-col gap-1">
        {rows.map((row) => (
          <li
            key={row.key}
            className="flex flex-wrap items-center gap-x-3 gap-y-1 text-small"
          >
            <span className="text-ink-muted">{row.label}</span>
            {row.reference.kind === "hidden" ? (
              <span>{t("issues.lifecycle.hidden")}</span>
            ) : (
              <>
                <span>{row.reference.typeName}</span>
                <span className="font-data text-data text-ink-muted">
                  {localDayOfInstant(row.reference.createdAt)}
                </span>
                <IssueStatusChip meaning={row.reference.meaning} />
              </>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * Merging this issue into another as its duplicate (decision 22): the issue
 * closes as Dublett, and its reporter follows the other one. Two presses,
 * because the reporter is told their report is handled elsewhere, and only
 * reopening the duplicate takes that back.
 *
 * Offered only issues on screen that are not themselves duplicates and not
 * done; the server refuses a chain, a closed issue and an issue the handler
 * does not handle either way.
 */
function MergeForm({
  issue,
  candidates,
  onChanged,
}: {
  issue: QueuedIssue;
  candidates: readonly QueuedIssue[];
  onChanged: () => void;
}): ReactElement | null {
  const { t } = useTranslation();
  const fieldId = useId();
  const [intoIssueId, setIntoIssueId] = useState("");
  const [confirming, setConfirming] = useState(false);
  const merge = useSaveAction(
    (into: string) => mergeIssue({ issueId: issue.id, intoIssueId: into }),
    () => {
      setConfirming(false);
      onChanged();
    },
    (failure) => {
      setConfirming(false);
      if (STALE_REASONS.has(failure.reason)) {
        onChanged();
      }
    },
  );
  const offered = candidates.filter(
    (candidate) =>
      candidate.id !== issue.id &&
      candidate.outcome !== "DUPLICATE" &&
      candidate.meaning !== "DONE",
  );
  if (offered.length === 0) {
    return null;
  }
  const busy = merge.state.kind === "saving";

  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-label text-ink-muted uppercase">
        {t("issues.lifecycle.mergeTitle")}
      </h3>
      {merge.state.kind === "failed" ? (
        <Notice tone="danger" live>
          {t(
            failureMessageKey(
              merge.state.failure,
              LIFECYCLE_FAILURES,
              "issues.lifecycle.errors.unknown",
            ),
          )}
        </Notice>
      ) : null}
      <label className={LABEL} htmlFor={fieldId}>
        {t("issues.lifecycle.mergeInto")}
      </label>
      <select
        id={fieldId}
        aria-label={t("issues.lifecycle.mergeIntoNamed", {
          type: issue.typeName,
        })}
        value={intoIssueId}
        disabled={busy}
        onChange={(event) => {
          setIntoIssueId(event.target.value);
          setConfirming(false);
          if (merge.state.kind === "failed") {
            merge.reset();
          }
        }}
        className={FIELD}
      >
        <option value="">{t("issues.lifecycle.mergePick")}</option>
        {offered.map((candidate) => (
          <option key={candidate.id} value={candidate.id}>
            {candidateLabel(candidate)}
          </option>
        ))}
      </select>
      <p className={HINT}>{t("issues.lifecycle.mergeHint")}</p>
      <TwoPressConfirm
        confirming={confirming}
        busy={busy}
        askDisabled={busy || intoIssueId === ""}
        askText={t("issues.lifecycle.merge")}
        askClassName={SECONDARY_BUTTON}
        confirmText={t("issues.lifecycle.mergeConfirm")}
        keepText={t("issues.lifecycle.mergeKeep")}
        onAsk={() => {
          setConfirming(true);
        }}
        onConfirm={() => {
          void merge.submit(intoIssueId);
        }}
        onKeep={() => {
          setConfirming(false);
        }}
      />
    </section>
  );
}

/**
 * An issue as the merge picker names it: its type, the day it was filed and
 * the first words of where it is, which the handler already reads in the
 * queue beside it.
 */
function candidateLabel(candidate: QueuedIssue): string {
  const where = candidate.location ?? candidate.description;
  const excerpt = where.length > 40 ? `${where.slice(0, 40)}…` : where;
  return `${candidate.typeName} · ${localDayOfInstant(candidate.createdAt)} · ${excerpt}`;
}

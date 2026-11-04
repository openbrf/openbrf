import { useState, type ReactElement } from "react";
import { Trans, useTranslation } from "react-i18next";

import type { ApiResult } from "../api/client";
import {
  type IssueRedaction,
  type QueuedIssue,
  redactIssue,
  setIssueLegalHold,
} from "../api/issues";
import { localDayOfInstant } from "../bookings/booking-calendar";
import type { TranslationKey } from "../i18n/translation-key";
import { CAUTION_BUTTON, HINT, SECONDARY_BUTTON } from "../ui/controls";
import { DATA_TAGS } from "../ui/data-tags";
import { Notice } from "../ui/Notice";
import { failureMessageKey, useSaveAction } from "../ui/save-state";
import { TwoPressConfirm } from "../ui/TwoPressConfirm";

const FAILURES: Readonly<Record<string, TranslationKey>> = {
  "legal-hold": "issues.redaction.errors.legalHold",
  "redaction-target-not-found": "issues.redaction.errors.targetNotFound",
  "issue-not-found": "issues.handling.errors.issueNotFound",
  "invalid-body": "issues.redaction.errors.unknown",
};

/**
 * The refusals that mean the issue on screen is out of date: it is gone, what
 * was to be removed is gone, or a hold was placed since it was read. The issue
 * and its conversation are read again, as their messages say.
 */
const STALE_REASONS: ReadonlySet<string> = new Set([
  "legal-hold",
  "redaction-target-not-found",
  "issue-not-found",
]);

/** One act on an issue's free text, so they share one save in flight. */
type Act =
  | { kind: "redact"; redaction: IssueRedaction }
  | { kind: "hold"; held: boolean };

function perform(issueId: string, act: Act): Promise<ApiResult<unknown>> {
  return act.kind === "redact"
    ? redactIssue({ issueId, redaction: act.redaction })
    : setIssueLegalHold({ issueId, held: act.held });
}

/** The key of one remove act, so only one question is open at a time. */
function keyOf(redaction: IssueRedaction): string {
  return "id" in redaction
    ? `${redaction.target}:${redaction.id}`
    : redaction.target;
}

/**
 * The removals and the legal hold on one open issue (ADR 0057), shared by the
 * panel that removes the description, the location and the photographs and by
 * the conversation, which removes messages, notes and files.
 *
 * One save in flight for all of them, and one question open at a time. Every
 * answer reads the queue again and bumps `revision`, which the conversation
 * reads again on: a removed message changes nothing on the issue's own row.
 */
export interface IssueRedactionControl {
  /** False while a legal hold stands: nothing is offered for removal then. */
  offered: boolean;
  busy: boolean;
  /** The remove act whose question is open, or null. */
  confirming: string | null;
  /** Bumped after every answer, to read the conversation again. */
  revision: number;
  ask: (redaction: IssueRedaction) => void;
  keep: () => void;
  redact: (redaction: IssueRedaction) => void;
  setHold: (held: boolean) => void;
  failureKey: TranslationKey | null;
}

export function useIssueRedaction(
  issue: QueuedIssue,
  onChanged: () => void,
): IssueRedactionControl {
  const [confirming, setConfirming] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const save = useSaveAction(
    (act: Act) => perform(issue.id, act),
    () => {
      setConfirming(null);
      setRevision((count) => count + 1);
      onChanged();
    },
    (failure) => {
      setConfirming(null);
      if (STALE_REASONS.has(failure.reason)) {
        setRevision((count) => count + 1);
        onChanged();
      }
    },
  );
  /** A refusal is about the act that was asked; a new question clears it. */
  const clearFailure = (): void => {
    if (save.state.kind === "failed") {
      save.reset();
    }
  };

  return {
    offered: issue.legalHoldAt === null,
    busy: save.pending,
    confirming,
    revision,
    ask: (redaction) => {
      clearFailure();
      setConfirming(keyOf(redaction));
    },
    keep: () => {
      setConfirming(null);
    },
    redact: (redaction) => {
      if (!save.pending) {
        void save.submit({ kind: "redact", redaction });
      }
    },
    setHold: (held) => {
      clearFailure();
      if (!save.pending) {
        void save.submit({ kind: "hold", held });
      }
    },
    failureKey:
      save.state.kind === "failed"
        ? failureMessageKey(
            save.state.failure,
            FAILURES,
            "issues.redaction.errors.unknown",
          )
        : null,
  };
}

/**
 * Remove, asked twice, with what removing means beside the second question:
 * nothing keeps the text, and nothing is written in its place.
 */
export function RedactAct({
  control,
  redaction,
  label,
}: {
  control: IssueRedactionControl;
  redaction: IssueRedaction;
  /** Names what is removed, where every row offers the act. */
  label: string;
}): ReactElement | null {
  const { t } = useTranslation();
  if (!control.offered) {
    return null;
  }
  const confirming = control.confirming === keyOf(redaction);
  return (
    <span className="flex flex-col gap-1">
      <TwoPressConfirm
        confirming={confirming}
        busy={control.busy}
        askText={t("issues.redaction.remove")}
        askLabel={label}
        confirmText={
          control.busy
            ? t("issues.redaction.removing")
            : t("issues.redaction.confirm")
        }
        keepText={t("issues.redaction.keep")}
        onAsk={() => {
          control.ask(redaction);
        }}
        onConfirm={() => {
          control.redact(redaction);
        }}
        onKeep={control.keep}
      />
      {confirming ? (
        <span className={HINT}>{t("issues.redaction.confirmHint")}</span>
      ) : null}
    </span>
  );
}

/**
 * The free text a handler may remove from the issue itself - its description,
 * its location and its reporter's photographs - and the legal hold that keeps
 * all of it. The conversation's messages, notes and files are removed where
 * they are shown.
 */
export function IssueFreeTextSection({
  issue,
  control,
}: {
  issue: QueuedIssue;
  control: IssueRedactionControl;
}): ReactElement {
  const { t } = useTranslation();
  const named = { type: issue.typeName };
  const describes =
    issue.descriptionRedactedAt === null && issue.description !== "";
  const locates = issue.location !== null;
  const nothingLeft = !describes && !locates && issue.photos.length === 0;

  return (
    <section className="flex flex-col gap-3">
      <h3 className="text-label text-ink-muted uppercase">
        {t("issues.redaction.title")}
      </h3>
      {control.failureKey === null ? null : (
        <Notice tone="danger" live>
          {t(control.failureKey)}
        </Notice>
      )}

      <LegalHold issue={issue} control={control} />

      {control.offered ? (
        <>
          {nothingLeft ? (
            <p className={HINT}>{t("issues.redaction.nothingLeft")}</p>
          ) : (
            <>
              <p className={HINT}>{t("issues.redaction.intro")}</p>
              <ul className="flex flex-col gap-2">
                {describes ? (
                  <li className="flex flex-wrap items-center gap-3 text-small">
                    <span>{t("issues.redaction.description")}</span>
                    <RedactAct
                      control={control}
                      redaction={{ target: "description" }}
                      label={t("issues.redaction.removeDescription", named)}
                    />
                  </li>
                ) : null}
                {locates ? (
                  <li className="flex flex-wrap items-center gap-3 text-small">
                    <span>{t("issues.redaction.location")}</span>
                    <RedactAct
                      control={control}
                      redaction={{ target: "location" }}
                      label={t("issues.redaction.removeLocation", named)}
                    />
                  </li>
                ) : null}
                {issue.photos.map((photo) => (
                  <li
                    key={photo.id}
                    className="flex flex-wrap items-center gap-3 text-small"
                  >
                    <img
                      src={photo.url}
                      alt={t("issues.photos.alt", { name: photo.fileName })}
                      className="size-12 rounded-control border border-line object-cover"
                    />
                    <span>{photo.fileName}</span>
                    <RedactAct
                      control={control}
                      redaction={{ target: "photo", id: photo.id }}
                      label={t("issues.redaction.removePhoto", {
                        name: photo.fileName,
                      })}
                    />
                  </li>
                ))}
              </ul>
            </>
          )}
        </>
      ) : (
        <p className={HINT}>{t("issues.redaction.heldNotice")}</p>
      )}
    </section>
  );
}

/**
 * The legal hold: placed at once, released only when asked twice, because a
 * release lets the clock remove the free text in the nights that follow.
 */
function LegalHold({
  issue,
  control,
}: {
  issue: QueuedIssue;
  control: IssueRedactionControl;
}): ReactElement {
  const { t } = useTranslation();
  const [releasing, setReleasing] = useState(false);
  const named = { type: issue.typeName };

  return (
    <div className="flex flex-col gap-2">
      {issue.legalHoldAt === null ? (
        <p className="text-small">{t("issues.redaction.legalHold.none")}</p>
      ) : (
        <p className="text-small font-semibold">
          <Trans
            i18nKey="issues.redaction.legalHold.since"
            values={{ date: localDayOfInstant(issue.legalHoldAt) }}
            components={DATA_TAGS}
          />
        </p>
      )}
      <p className={HINT}>{t("issues.redaction.legalHold.hint")}</p>
      <div>
        {issue.legalHoldAt === null ? (
          <button
            type="button"
            disabled={control.busy}
            aria-label={t("issues.redaction.legalHold.placeNamed", named)}
            onClick={() => {
              control.setHold(true);
            }}
            className={SECONDARY_BUTTON}
          >
            {control.busy
              ? t("issues.redaction.legalHold.saving")
              : t("issues.redaction.legalHold.place")}
          </button>
        ) : (
          <span className="flex flex-col gap-1">
            <TwoPressConfirm
              confirming={releasing}
              busy={control.busy}
              askText={t("issues.redaction.legalHold.release")}
              askLabel={t("issues.redaction.legalHold.releaseNamed", named)}
              askClassName={CAUTION_BUTTON}
              confirmText={t("issues.redaction.legalHold.releaseConfirm")}
              keepText={t("issues.redaction.legalHold.releaseKeep")}
              onAsk={() => {
                setReleasing(true);
              }}
              onConfirm={() => {
                setReleasing(false);
                control.setHold(false);
              }}
              onKeep={() => {
                setReleasing(false);
              }}
            />
            {releasing ? (
              <span className={HINT}>
                {t("issues.redaction.legalHold.releaseHint")}
              </span>
            ) : null}
          </span>
        )}
      </div>
    </div>
  );
}

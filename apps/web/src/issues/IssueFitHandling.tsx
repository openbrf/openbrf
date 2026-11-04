import {
  ISSUE_FINDING_KINDS,
  type IssueFindingKind,
  latestFindingTargetDate,
} from "@openbrf/shared";
import { useEffect, useState, type ReactElement } from "react";
import { Trans, useTranslation } from "react-i18next";

import type { ApiResult } from "../api/client";
import {
  answerEntry,
  fetchIssueAttachments,
  fetchIssuePlaceCounts,
  type IssueAttachment,
  type IssueFindingInput,
  type IssuePlaceCount,
  markIssueFinding,
  type QueuedIssue,
  removeIssueFinding,
  setIssuePlace,
  withdrawEntry,
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
import { DATA_TAGS } from "../ui/data-tags";
import { Notice } from "../ui/Notice";
import { failureMessageKey, useSaveAction } from "../ui/save-state";
import { EntryPermissionForm } from "./EntryPermissionForm";

const FAILURES: Readonly<Record<string, TranslationKey>> = {
  "issue-not-found": "issues.fit.errors.issueNotFound",
  "issue-closed": "issues.fit.errors.closed",
  "place-not-found": "issues.fit.errors.placeNotFound",
  "place-with-apartment": "issues.fit.errors.placeWithApartment",
  "finding-needs-target-date": "issues.fit.errors.findingNeedsTargetDate",
  "finding-target-date-too-late": "issues.fit.errors.findingTargetDateTooLate",
  "finding-protocol-not-found": "issues.fit.errors.protocolNotFound",
  "date-invalid": "issues.fit.errors.dateInvalid",
  "invalid-body": "issues.fit.errors.unknown",
};

/** The refusals that mean the issue on screen is out of date. */
const STALE_REASONS: ReadonlySet<string> = new Set([
  "issue-not-found",
  "issue-closed",
  "place-not-found",
  "finding-protocol-not-found",
]);

const FINDING_KIND_LABEL: Readonly<Record<IssueFindingKind, TranslationKey>> = {
  OVK: "issues.fit.finding.kinds.OVK",
  LIFT: "issues.fit.finding.kinds.LIFT",
  FIRE: "issues.fit.finding.kinds.FIRE",
};

/** One act on the place or the finding, so they share one save in flight. */
type Act =
  | { kind: "place"; placeId: string | null }
  | { kind: "mark"; finding: IssueFindingInput }
  | { kind: "unmark" };

function perform(issueId: string, act: Act): Promise<ApiResult<QueuedIssue>> {
  switch (act.kind) {
    case "place":
      return setIssuePlace({ issueId, placeId: act.placeId });
    case "mark":
      return markIssueFinding({ issueId, finding: act.finding });
    case "unmark":
      return removeIssueFinding(issueId);
  }
}

/**
 * What is particular to a Swedish house on an issue, for the handler (decisions
 * 29 to 31): the common-area place it is about, the resident's permission to
 * enter, and the mark of an inspection finding.
 *
 * Mounted with the rest of the handling, only while a handler has the issue
 * open. A place is offered on an issue that is not about an apartment, as the
 * report form offers it. The entry permission is offered on an issue about an
 * apartment that is not done, because it is cleared when the issue closes; the
 * finding on an issue that is not done. The server decides all of it again.
 *
 * Whether the issue is about an apartment is `aboutApartment`, never
 * `apartment`: the queue withholds the apartment of a reporter with protected
 * personal data, and their issue is still about it.
 */
export function IssueFitHandling({
  issue,
  onChanged,
}: {
  issue: QueuedIssue;
  onChanged: () => void;
}): ReactElement {
  const { t } = useTranslation();
  const [places, setPlaces] = useState<readonly IssuePlaceCount[] | null>(null);
  const [attachments, setAttachments] = useState<
    readonly IssueAttachment[] | null
  >(null);
  const [reads, setReads] = useState(0);

  // Two reads, each in its own effect: the place list is what the selector
  // waits for, and a stalled attachment read must not keep it disabled.
  useEffect(() => {
    let active = true;
    void fetchIssuePlaceCounts().then((placeRead) => {
      if (active) {
        setPlaces(placeRead.ok ? placeRead.value : null);
      }
    });
    return () => {
      active = false;
    };
  }, [issue.id, issue.updatedAt, reads]);

  useEffect(() => {
    let active = true;
    void fetchIssueAttachments(issue.id).then((attachmentRead) => {
      if (active) {
        setAttachments(attachmentRead.ok ? attachmentRead.value : null);
      }
    });
    return () => {
      active = false;
    };
  }, [issue.id, issue.updatedAt, reads]);

  const save = useSaveAction(
    (act: Act) => perform(issue.id, act),
    () => {
      setReads((count) => count + 1);
      onChanged();
    },
    (failure) => {
      if (STALE_REASONS.has(failure.reason)) {
        onChanged();
        setReads((count) => count + 1);
      }
    },
  );
  const busy = save.pending;
  const onDraftChanged = (): void => {
    if (save.state.kind === "failed") {
      save.reset();
    }
  };

  const open = issue.meaning !== "DONE";
  const current = issue.place;
  const offered = (places ?? []).filter(
    (place) => place.active || place.id === current?.id,
  );
  // The place as it stands, offered even when the list did not load or no
  // longer holds it, so the select never shows another place than the issue's.
  const options =
    current !== null && !offered.some((place) => place.id === current.id)
      ? [{ id: current.id, name: current.name }, ...offered]
      : offered;

  return (
    <div className="flex flex-col gap-4">
      {save.state.kind === "failed" ? (
        <Notice tone="danger" live>
          {t(
            failureMessageKey(
              save.state.failure,
              FAILURES,
              "issues.fit.errors.unknown",
            ),
          )}
        </Notice>
      ) : null}

      {issue.aboutApartment ? null : (
        <PlaceForm
          key={`place:${current?.id ?? ""}`}
          initial={current?.id ?? ""}
          options={options}
          // A failed or unfinished place read leaves a place that is set
          // clearable (the API clears without reading the list), and nothing
          // else to choose.
          disabled={busy || (places === null && current === null)}
          onDraftChanged={onDraftChanged}
          onSave={(placeId) => {
            void save.submit({
              kind: "place",
              placeId: placeId === "" ? null : placeId,
            });
          }}
        />
      )}

      {issue.aboutApartment && open ? (
        <section className="flex flex-col gap-2">
          <h3 className="text-label text-ink-muted uppercase">
            {t("issues.entry.title")}
          </h3>
          <EntryPermissionForm
            key={JSON.stringify(issue.entry)}
            entry={issue.entry}
            audience="handler"
            answer={(entry) => answerEntry({ issueId: issue.id, entry })}
            withdraw={() => withdrawEntry(issue.id)}
            onChanged={onChanged}
          />
        </section>
      ) : null}

      {open || issue.finding !== null ? (
        <FindingSection
          key={`finding:${JSON.stringify(issue.finding)}:${issue.targetDate ?? ""}`}
          issue={issue}
          attachments={attachments}
          disabled={busy}
          closed={!open}
          onDraftChanged={onDraftChanged}
          onMark={(finding) => {
            void save.submit({ kind: "mark", finding });
          }}
          onUnmark={() => {
            void save.submit({ kind: "unmark" });
          }}
        />
      ) : null}
    </div>
  );
}

/** The common-area place: one select and its save, for a real change. */
function PlaceForm({
  initial,
  options,
  disabled,
  onDraftChanged,
  onSave,
}: {
  initial: string;
  options: readonly { id: string; name: string }[];
  disabled: boolean;
  onDraftChanged: () => void;
  onSave: (placeId: string) => void;
}): ReactElement {
  const { t } = useTranslation();
  const [value, setValue] = useState(initial);
  return (
    <form
      className="flex items-end gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (value !== initial) {
          onSave(value);
        }
      }}
    >
      <label className={`${LABEL} min-w-44`}>
        {t("issues.fit.place.label")}
        <select
          value={value}
          disabled={disabled}
          onChange={(event) => {
            setValue(event.target.value);
            onDraftChanged();
          }}
          className={FIELD}
        >
          <option value="">{t("issues.fit.place.none")}</option>
          {options.map((place) => (
            <option key={place.id} value={place.id}>
              {place.name}
            </option>
          ))}
        </select>
      </label>
      <button
        type="submit"
        disabled={disabled || value === initial}
        className={SECONDARY_BUTTON}
      >
        {t("issues.handling.save")}
      </button>
    </form>
  );
}

/**
 * The mark of an OVK, lift or fire finding (decision 31): the kind, the day of
 * the inspection, the protocol - one of the issue's own handler files - and a
 * real target date, which is the issue's target date.
 *
 * A lift's target date is held to a month from the inspection (BFS 2025:11 1 kap.
 * 17 §), and the form says so and offers that day, so it is not found out from
 * a refusal. An OVK or fire finding has the date the handler sets; the law
 * names none here.
 */
function FindingSection({
  issue,
  attachments,
  disabled,
  closed,
  onDraftChanged,
  onMark,
  onUnmark,
}: {
  issue: QueuedIssue;
  attachments: readonly IssueAttachment[] | null;
  disabled: boolean;
  /**
   * The issue is done: the server refuses a mark or a change then, and still
   * takes the mark off, so only the fields and their save are switched off.
   */
  closed: boolean;
  onDraftChanged: () => void;
  onMark: (finding: IssueFindingInput) => void;
  onUnmark: () => void;
}): ReactElement {
  const { t } = useTranslation();
  const finding = issue.finding;
  const editDisabled = disabled || closed;
  const [draft, setDraft] = useState({
    kind: (finding?.kind ?? "") as IssueFindingKind | "",
    inspectedOn: finding?.inspectedOn ?? "",
    protocolAttachmentId: finding?.protocol?.attachmentId ?? "",
    targetDate: issue.targetDate ?? "",
  });
  const change = (next: Partial<typeof draft>): void => {
    setDraft({ ...draft, ...next });
    onDraftChanged();
  };

  const latest =
    draft.kind === "" || draft.inspectedOn === ""
      ? null
      : latestFindingTargetDate(draft.kind, draft.inspectedOn);
  const tooLate = latest !== null && draft.targetDate > latest;
  const complete =
    draft.kind !== "" &&
    draft.inspectedOn !== "" &&
    draft.protocolAttachmentId !== "" &&
    draft.targetDate !== "";
  const unchanged =
    finding !== null &&
    draft.kind === finding.kind &&
    draft.inspectedOn === finding.inspectedOn &&
    draft.protocolAttachmentId === (finding.protocol?.attachmentId ?? "") &&
    draft.targetDate === (issue.targetDate ?? "");

  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-label text-ink-muted uppercase">
        {t("issues.fit.finding.title")}
      </h3>
      <p className={HINT}>{t("issues.fit.finding.intro")}</p>

      {finding !== null ? (
        <p className="text-small">
          {t("issues.fit.finding.current", {
            kind: t(FINDING_KIND_LABEL[finding.kind]),
          })}{" "}
          {finding.protocol === null ? (
            <span className="text-ink-muted">
              {t("issues.fit.finding.protocolGone")}
            </span>
          ) : (
            <span>
              {t("issues.fit.finding.protocolIs", {
                name: finding.protocol.fileName,
              })}
            </span>
          )}
        </p>
      ) : null}

      <form
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (!complete || tooLate || unchanged || draft.kind === "") {
            return;
          }
          onMark({
            kind: draft.kind,
            inspectedOn: draft.inspectedOn,
            protocolAttachmentId: draft.protocolAttachmentId,
            targetDate: draft.targetDate,
          });
        }}
      >
        <div className="flex flex-wrap items-end gap-4">
          <label className={`${LABEL} min-w-44`}>
            {t("issues.fit.finding.kind")}
            <select
              value={draft.kind}
              disabled={editDisabled}
              onChange={(event) => {
                change({ kind: event.target.value as IssueFindingKind | "" });
              }}
              className={FIELD}
            >
              <option value="">{t("issues.fit.finding.kindNone")}</option>
              {ISSUE_FINDING_KINDS.map((kind) => (
                <option key={kind} value={kind}>
                  {t(FINDING_KIND_LABEL[kind])}
                </option>
              ))}
            </select>
          </label>

          <label className={`${LABEL} min-w-44`}>
            {t("issues.fit.finding.inspectedOn")}
            <input
              type="date"
              value={draft.inspectedOn}
              disabled={editDisabled}
              onChange={(event) => {
                change({ inspectedOn: event.target.value });
              }}
              className={FIELD_DATA}
            />
          </label>

          <label className={`${LABEL} min-w-44`}>
            {t("issues.fit.finding.targetDate")}
            <input
              type="date"
              value={draft.targetDate}
              disabled={editDisabled}
              aria-invalid={tooLate ? true : undefined}
              onChange={(event) => {
                change({ targetDate: event.target.value });
              }}
              className={FIELD_DATA}
            />
          </label>
        </div>

        {latest === null ? null : (
          <p className={HINT}>
            <Trans
              i18nKey="issues.fit.finding.liftRule"
              values={{ date: latest }}
              components={DATA_TAGS}
            />{" "}
            {draft.targetDate === "" ? (
              <button
                type="button"
                className={QUIET_BUTTON}
                disabled={editDisabled}
                onClick={() => {
                  change({ targetDate: latest });
                }}
              >
                {t("issues.fit.finding.useLatest")}
              </button>
            ) : null}
          </p>
        )}
        {tooLate ? (
          <Notice tone="warn" live>
            {t("issues.fit.errors.findingTargetDateTooLate")}
          </Notice>
        ) : null}

        <label className={LABEL}>
          {t("issues.fit.finding.protocol")}
          <select
            value={draft.protocolAttachmentId}
            disabled={editDisabled || attachments === null}
            onChange={(event) => {
              change({ protocolAttachmentId: event.target.value });
            }}
            className={FIELD}
          >
            <option value="">{t("issues.fit.finding.protocolNone")}</option>
            {(attachments ?? []).map((attachment) => (
              <option key={attachment.id} value={attachment.id}>
                {attachment.fileName}
              </option>
            ))}
          </select>
          <span className={HINT}>
            {attachments !== null && attachments.length === 0
              ? t("issues.fit.finding.attachFirst")
              : t("issues.fit.finding.protocolHint")}
          </span>
        </label>

        <div className="flex flex-wrap gap-2">
          <button
            type="submit"
            disabled={editDisabled || !complete || tooLate || unchanged}
            className={SECONDARY_BUTTON}
          >
            {finding === null
              ? t("issues.fit.finding.mark")
              : t("issues.fit.finding.change")}
          </button>
          {finding === null ? null : (
            <button
              type="button"
              disabled={disabled}
              className={QUIET_BUTTON}
              onClick={onUnmark}
            >
              {t("issues.fit.finding.remove")}
            </button>
          )}
        </div>
      </form>
    </section>
  );
}

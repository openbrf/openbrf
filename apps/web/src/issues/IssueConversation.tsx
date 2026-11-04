import { useEffect, useRef, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";

import {
  addIssueNote,
  attachIssueFile,
  fetchIssueAttachments,
  fetchIssueMessages,
  fetchIssueNotes,
  fetchIssueSavedReplies,
  type IssueAttachment,
  type IssueMessage,
  type IssueNote,
  type IssueSavedReply,
  type QueuedIssue,
  sendIssueMessage,
} from "../api/issues";
import type { TranslationKey } from "../i18n/translation-key";
import { HINT, SECONDARY_BUTTON } from "../ui/controls";
import { formatMoment } from "../ui/moment";
import { Notice } from "../ui/Notice";
import { failureMessageKey, useSaveAction } from "../ui/save-state";
import { ConversationComposer } from "./ConversationComposer";
import { ISSUE_SIGNATURE_LABEL } from "./issue-labels";
import { ConversationText } from "./IssueFreeText";
import { IssueHandlerName } from "./IssueHandlerName";
import { type IssueRedactionControl, RedactAct } from "./IssueRedaction";

const WRITE_FAILURES: Readonly<Record<string, TranslationKey>> = {
  "issue-not-found": "issues.conversation.errors.issueNotFoundHandler",
  "no-reporter": "issues.conversation.errors.noReporter",
  "personal-identity-number":
    "issues.conversation.errors.personalIdentityNumber",
  "invalid-body": "issues.conversation.errors.unknown",
};

const ATTACH_FAILURES: Readonly<Record<string, TranslationKey>> = {
  "issue-not-found": "issues.conversation.errors.issueNotFoundHandler",
  "too-many-attachments": "issues.attachments.errors.tooMany",
  "too-large": "issues.attachments.errors.tooLarge",
  "unsupported-type": "issues.attachments.errors.unsupported",
  "empty-file": "issues.attachments.errors.unsupported",
  "no-file": "issues.attachments.errors.unsupported",
};

/** What the media layer identifies: an image, or a PDF. */
const ATTACHMENT_TYPES =
  "image/png,image/jpeg,image/webp,image/gif,application/pdf";

/** The refusals that mean the issue on screen is out of date. */
const STALE_REASONS: ReadonlySet<string> = new Set(["issue-not-found"]);

/** Everything the panel reads, applied to the screen in one step. */
interface Read {
  messages: IssueMessage[] | null;
  notes: IssueNote[] | null;
  attachments: IssueAttachment[] | null;
  savedReplies: IssueSavedReply[];
  failed: boolean;
  /** The saved replies are read apart: a picker that is missing says why. */
  savedRepliesFailed: boolean;
}

/**
 * The conversation on one issue, as a handler works it (decision 18): the
 * messages with the reporter, the handlers' internal notes beside them, and the
 * files the handlers attached for each other.
 *
 * Mounted only while a handler has the issue open, beside its handling. The
 * three are kept apart on the screen as they are on the server: a note and a
 * handler's file are never the reporter's, and are said so where they are
 * written. A message is signed to the reporter with a role, never the writer's
 * name (decision 19); the handlers see both.
 *
 * Each read answers only the issue and the read that asked for it: a newer
 * read, or the panel closing, drops an older answer.
 */
export function IssueConversation({
  issue,
  onStale,
  redaction,
}: {
  issue: QueuedIssue;
  /** Told when the server says the issue is no longer the reader's to see. */
  onStale: () => void;
  /**
   * The removals on this issue (ADR 0057), shared with the panel that removes
   * its description and photographs. Each answer bumps its revision, which
   * reads the conversation again: a removed message changes nothing on the
   * issue's own row.
   */
  redaction?: IssueRedactionControl;
}): ReactElement {
  const { t } = useTranslation();
  const [read, setRead] = useState<Read>({
    messages: null,
    notes: null,
    attachments: null,
    savedReplies: [],
    failed: false,
    savedRepliesFailed: false,
  });
  /** Bumped after every write here, which reads the panel again. */
  const [reads, setReads] = useState(0);
  /*
   * The issue's own revision, read again whenever the queue brings a newer one.
   * A status or handling saved beside this panel reloads the queue without
   * remounting the open conversation and without a write of its own here, so
   * neither the issue's id nor `reads` changes, and the panel would keep what
   * it read before - a board-only change among it. Each read still answers only
   * the issue and revision that asked for it: the cleanup below drops a
   * superseded one.
   */
  const revision = `${issue.updatedAt}:${issue.status.id}`;
  /*
   * The caller's callback as of the latest render, so a read that finishes
   * tells the queue through the current one without a new callback, which an
   * inline function is on every render, starting the reads over.
   */
  const staleRef = useRef(onStale);
  useEffect(() => {
    staleRef.current = onStale;
  });

  /*
   * The redaction revision the lists on screen were read at. A removal changes
   * what the server holds, so the copy on screen is dropped when the revision
   * moves: were the read that follows to fail, a failed read keeps what the
   * screen shows, and the bodies just removed would stand beside the failure
   * notice. An ordinary read after a sent note or message keeps the thread.
   */
  const redactionRevision = redaction?.revision;
  const shownAtRedaction = useRef(redactionRevision);
  /*
   * The same for the nightly purge, which removes the thread without any
   * answer here: the issue's own `freeTextRemovedAt` moves when it has, and
   * the lists are dropped with it for the same reason.
   */
  const purgedAt = issue.freeTextRemovedAt;
  const shownAtPurge = useRef(purgedAt);

  useEffect(() => {
    if (
      shownAtRedaction.current !== redactionRevision ||
      shownAtPurge.current !== purgedAt
    ) {
      shownAtRedaction.current = redactionRevision;
      shownAtPurge.current = purgedAt;
      setRead((current) => ({
        ...current,
        messages: null,
        notes: null,
        attachments: null,
      }));
    }
    let active = true;
    void Promise.all([
      fetchIssueMessages(issue.id),
      fetchIssueNotes(issue.id),
      fetchIssueAttachments(issue.id),
      fetchIssueSavedReplies(),
    ]).then(([messages, notes, attachments, savedReplies]) => {
      if (!active) {
        return;
      }
      // An issue the reader may no longer open is not one to keep on screen:
      // the queue is read again, which drops the row and this panel with it.
      if (
        [messages, notes, attachments].some(
          (answer) => !answer.ok && STALE_REASONS.has(answer.failure.reason),
        )
      ) {
        staleRef.current();
      }
      // A failed read keeps what the screen already shows, and says so.
      setRead((current) => ({
        messages: messages.ok ? messages.value : current.messages,
        notes: notes.ok ? notes.value : current.notes,
        attachments: attachments.ok ? attachments.value : current.attachments,
        savedReplies: savedReplies.ok
          ? savedReplies.value
          : current.savedReplies,
        failed: !messages.ok || !notes.ok || !attachments.ok,
        savedRepliesFailed: !savedReplies.ok,
      }));
    });
    return () => {
      active = false;
    };
  }, [issue.id, revision, reads, redactionRevision, purgedAt]);

  const reread = (): void => {
    setReads((count) => count + 1);
  };
  const refused = (reason: string): void => {
    if (STALE_REASONS.has(reason)) {
      onStale();
    }
  };
  // Only a reporter with an account reads the conversation. One who left an
  // address alone, as a report from the website's form may, has no way to see a
  // reply, and nothing is mailed (decision 21).
  const reachable =
    issue.reporter.kind === "resident" || issue.reporter.kind === "protected";
  const named = { type: issue.typeName };

  return (
    <div className="flex flex-col gap-6">
      {read.failed ? (
        <Notice tone="danger" live>
          {t("issues.conversation.readFailedHandler")}
        </Notice>
      ) : null}
      {read.savedRepliesFailed ? (
        <Notice tone="danger" live>
          {t("issues.conversation.savedRepliesReadFailed")}
        </Notice>
      ) : null}

      <section className="flex flex-col gap-2">
        <h3 className="text-label text-ink-muted uppercase">
          {t("issues.conversation.title")}
        </h3>
        <MessageList
          messages={read.messages}
          failed={read.failed}
          redaction={redaction}
        />
        {reachable ? (
          <ConversationComposer
            label={t("issues.conversation.message")}
            ariaLabel={t("issues.conversation.toReporterNamed", named)}
            hint={t("issues.conversation.toReporterHint")}
            sendLabel={t("issues.conversation.send")}
            sendingLabel={t("issues.conversation.sending")}
            failures={WRITE_FAILURES}
            fallback="issues.conversation.errors.unknown"
            send={(body) => sendIssueMessage({ issueId: issue.id, body })}
            onSent={reread}
            onRefused={refused}
            savedReplies={read.savedReplies}
          />
        ) : (
          <p className={HINT}>{t("issues.conversation.noReporter")}</p>
        )}
      </section>

      <section className="flex flex-col gap-2">
        <h3 className="text-label text-ink-muted uppercase">
          {t("issues.notes.title")}
        </h3>
        <p className={HINT}>{t("issues.notes.hint")}</p>
        <NoteList
          notes={read.notes}
          failed={read.failed}
          redaction={redaction}
        />
        <ConversationComposer
          label={t("issues.notes.label")}
          ariaLabel={t("issues.notes.labelNamed", named)}
          sendLabel={t("issues.notes.add")}
          sendingLabel={t("issues.notes.adding")}
          failures={WRITE_FAILURES}
          fallback="issues.conversation.errors.unknown"
          send={(body) => addIssueNote({ issueId: issue.id, body })}
          onSent={reread}
          onRefused={refused}
        />
      </section>

      <Attachments
        issue={issue}
        attachments={read.attachments}
        failed={read.failed}
        onAttached={reread}
        onRefused={refused}
        redaction={redaction}
      />
    </div>
  );
}

function MessageList({
  messages,
  failed,
  redaction,
}: {
  messages: IssueMessage[] | null;
  failed: boolean;
  redaction: IssueRedactionControl | undefined;
}): ReactElement | null {
  const { t, i18n } = useTranslation();
  if (messages === null) {
    return failed ? null : (
      <p role="status" className={HINT}>
        {t("issues.conversation.loading")}
      </p>
    );
  }
  if (messages.length === 0) {
    return <p className={HINT}>{t("issues.conversation.empty")}</p>;
  }
  return (
    <ol className="flex flex-col gap-2">
      {messages.map((message) => (
        <li
          key={message.id}
          className="flex flex-col gap-1 rounded-control border border-line px-3 py-2"
        >
          <span className="flex flex-wrap gap-x-3 text-small">
            {message.side === "HANDLER" ? (
              <>
                <span className="font-semibold">
                  <IssueHandlerName handler={message.author} />
                </span>
                <span className="text-ink-muted">
                  {t("issues.conversation.signedAs", {
                    role: t(ISSUE_SIGNATURE_LABEL[message.signature]),
                  })}
                </span>
              </>
            ) : (
              <span className="font-semibold">
                {t("issues.conversation.reporter")}
              </span>
            )}
            <span className="font-data text-data text-ink-muted">
              {formatMoment(message.createdAt, i18n.language)}
            </span>
          </span>
          <ConversationText
            body={message.body}
            redactedAt={message.redactedAt}
          />
          {redaction === undefined || message.redactedAt !== null ? null : (
            <RedactAct
              control={redaction}
              redaction={{ target: "message", id: message.id }}
              label={t("issues.redaction.removeMessage", {
                at: formatMoment(message.createdAt, i18n.language),
              })}
            />
          )}
        </li>
      ))}
    </ol>
  );
}

function NoteList({
  notes,
  failed,
  redaction,
}: {
  notes: IssueNote[] | null;
  failed: boolean;
  redaction: IssueRedactionControl | undefined;
}): ReactElement | null {
  const { t, i18n } = useTranslation();
  if (notes === null) {
    return failed ? null : (
      <p role="status" className={HINT}>
        {t("issues.conversation.loading")}
      </p>
    );
  }
  if (notes.length === 0) {
    return <p className={HINT}>{t("issues.notes.empty")}</p>;
  }
  return (
    <ol className="flex flex-col gap-2">
      {notes.map((note) => (
        <li
          key={note.id}
          className="flex flex-col gap-1 rounded-control border border-line bg-sunken px-3 py-2"
        >
          <span className="flex flex-wrap gap-x-3 text-small">
            <span className="font-semibold">
              <IssueHandlerName handler={note.author} />
            </span>
            <span className="font-data text-data text-ink-muted">
              {formatMoment(note.createdAt, i18n.language)}
            </span>
          </span>
          <ConversationText body={note.body} redactedAt={note.redactedAt} />
          {redaction === undefined || note.redactedAt !== null ? null : (
            <RedactAct
              control={redaction}
              redaction={{ target: "note", id: note.id }}
              label={t("issues.redaction.removeNote", {
                at: formatMoment(note.createdAt, i18n.language),
              })}
            />
          )}
        </li>
      ))}
    </ol>
  );
}

/**
 * The files the handlers attached for each other, and the upload. One upload
 * at a time; the list is read again once the server has the file.
 */
function Attachments({
  issue,
  attachments,
  failed,
  onAttached,
  onRefused,
  redaction,
}: {
  issue: QueuedIssue;
  attachments: IssueAttachment[] | null;
  failed: boolean;
  onAttached: () => void;
  onRefused: (reason: string) => void;
  redaction: IssueRedactionControl | undefined;
}): ReactElement {
  const { t } = useTranslation();
  const upload = useSaveAction(
    (file: File) => attachIssueFile({ issueId: issue.id, file }),
    onAttached,
    (failure) => {
      onRefused(failure.reason);
    },
  );
  const busy = upload.pending;

  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-label text-ink-muted uppercase">
        {t("issues.attachments.title")}
      </h3>
      <p className={HINT}>{t("issues.attachments.hint")}</p>

      {upload.state.kind === "failed" ? (
        <Notice tone="danger" live>
          {t(
            failureMessageKey(
              upload.state.failure,
              ATTACH_FAILURES,
              "issues.attachments.errors.unknown",
            ),
          )}
        </Notice>
      ) : null}

      {attachments === null ? (
        failed ? null : (
          <p role="status" className={HINT}>
            {t("issues.conversation.loading")}
          </p>
        )
      ) : attachments.length === 0 ? (
        <p className={HINT}>{t("issues.attachments.empty")}</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {attachments.map((attachment) => (
            <li
              key={attachment.id}
              className="flex flex-wrap items-center gap-3 text-small"
            >
              <a
                href={attachment.url}
                target="_blank"
                rel="noreferrer"
                className="inline-flex min-h-11 min-w-11 items-center justify-center underline"
              >
                {attachment.fileName}
              </a>
              {redaction === undefined ? null : (
                <RedactAct
                  control={redaction}
                  redaction={{ target: "attachment", id: attachment.id }}
                  label={t("issues.redaction.removeAttachment", {
                    name: attachment.fileName,
                  })}
                />
              )}
            </li>
          ))}
        </ul>
      )}

      <div>
        <label className="cursor-pointer">
          <input
            type="file"
            accept={ATTACHMENT_TYPES}
            disabled={busy}
            aria-label={t("issues.attachments.addNamed", {
              type: issue.typeName,
            })}
            onChange={(event) => {
              const file = event.target.files?.[0];
              // Cleared, so choosing the same file again is a change.
              event.target.value = "";
              if (upload.state.kind === "failed") {
                upload.reset();
              }
              if (file !== undefined && !busy) {
                void upload.submit(file);
              }
            }}
            className="peer sr-only"
          />
          <span
            className={[
              SECONDARY_BUTTON,
              // The input is visually hidden, so the focus ring is drawn on
              // the part the viewer can see, as on the report form.
              "peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2",
              "peer-focus-visible:outline-trust",
              "peer-disabled:opacity-60",
            ].join(" ")}
          >
            {busy
              ? t("issues.attachments.adding")
              : t("issues.attachments.add")}
          </span>
        </label>
      </div>
    </section>
  );
}

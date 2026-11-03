import { useEffect, useState, type ReactElement } from "react";
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
import { IssueHandlerName } from "./IssueHandlerName";

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
}: {
  issue: QueuedIssue;
  /** Told when the server says the issue is no longer the reader's to see. */
  onStale: () => void;
}): ReactElement {
  const { t } = useTranslation();
  const [read, setRead] = useState<Read>({
    messages: null,
    notes: null,
    attachments: null,
    savedReplies: [],
    failed: false,
  });
  /** Bumped after every write here, which reads the panel again. */
  const [reads, setReads] = useState(0);

  useEffect(() => {
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
      // A failed read keeps what the screen already shows, and says so.
      setRead((current) => ({
        messages: messages.ok ? messages.value : current.messages,
        notes: notes.ok ? notes.value : current.notes,
        attachments: attachments.ok ? attachments.value : current.attachments,
        savedReplies: savedReplies.ok
          ? savedReplies.value
          : current.savedReplies,
        failed: !messages.ok || !notes.ok || !attachments.ok,
      }));
    });
    return () => {
      active = false;
    };
  }, [issue.id, reads]);

  const reread = (): void => {
    setReads((count) => count + 1);
  };
  const refused = (reason: string): void => {
    if (STALE_REASONS.has(reason)) {
      onStale();
    }
  };
  const reachable =
    issue.reporter.kind === "resident" ||
    issue.reporter.kind === "protected" ||
    (issue.reporter.kind === "external" && issue.reporter.email !== null);
  const named = { type: issue.typeName };

  return (
    <div className="flex flex-col gap-6">
      {read.failed ? (
        <Notice tone="danger" live>
          {t("issues.conversation.readFailedHandler")}
        </Notice>
      ) : null}

      <section className="flex flex-col gap-2">
        <h3 className="text-label text-ink-muted uppercase">
          {t("issues.conversation.title")}
        </h3>
        <MessageList messages={read.messages} failed={read.failed} />
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
        <NoteList notes={read.notes} failed={read.failed} />
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
      />
    </div>
  );
}

function MessageList({
  messages,
  failed,
}: {
  messages: IssueMessage[] | null;
  failed: boolean;
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
          <p className="text-small whitespace-pre-line">{message.body}</p>
        </li>
      ))}
    </ol>
  );
}

function NoteList({
  notes,
  failed,
}: {
  notes: IssueNote[] | null;
  failed: boolean;
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
          <p className="text-small whitespace-pre-line">{note.body}</p>
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
}: {
  issue: QueuedIssue;
  attachments: IssueAttachment[] | null;
  failed: boolean;
  onAttached: () => void;
  onRefused: (reason: string) => void;
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
            <li key={attachment.id} className="text-small">
              <a
                href={attachment.url}
                target="_blank"
                rel="noreferrer"
                className="inline-flex min-h-11 items-center underline"
              >
                {attachment.fileName}
              </a>
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

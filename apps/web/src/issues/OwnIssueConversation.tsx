import { useEffect, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";

import {
  fetchOwnIssueMessages,
  type OwnIssue,
  type OwnIssueMessage,
  sendOwnIssueMessage,
} from "../api/issues";
import type { TranslationKey } from "../i18n/translation-key";
import { HINT, SECONDARY_BUTTON } from "../ui/controls";
import { formatMoment } from "../ui/moment";
import { Notice } from "../ui/Notice";
import { ConversationComposer } from "./ConversationComposer";
import { ISSUE_SIGNATURE_LABEL } from "./issue-labels";
import { ConversationText } from "./IssueFreeText";

const REPLY_FAILURES: Readonly<Record<string, TranslationKey>> = {
  "issue-not-found": "issues.conversation.errors.issueNotFound",
  "issue-closed": "issues.conversation.errors.issueClosed",
  "invalid-body": "issues.conversation.errors.unknown",
};

/**
 * The conversation on one's own report, under a disclosure (decision 18).
 *
 * Read only while it is open, as the queue reads an issue's handling. The
 * handlers' messages are signed with a role, the board or the property
 * manager, and never with a name (decision 19): that is the server's answer,
 * and nothing here could name a handler if it wanted to.
 *
 * What the field below the messages does is the server's answer
 * (`replyMode`, ADR 0054): on an open report it sends a message; on one closed
 * within the reopening window it says that the message reopens the report;
 * after that, and on a report merged into another, it gives way to a new
 * report that follows this one up.
 */
export function OwnIssueConversation({
  issue,
  onChanged,
  onFollowUp,
}: {
  issue: OwnIssue;
  /**
   * Told when the report changed: a reply reopened it, or the server says it
   * is closed where the list on screen did not yet know. The caller reads the
   * list again, and the field follows what it then says.
   */
  onChanged: () => void;
  /**
   * Told when the reporter asks for a new report following this one up, with
   * the reply the server refused as closed, when there was one, so the new
   * report can start from it.
   */
  onFollowUp: (refusedReply: string) => void;
}): ReactElement {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  return (
    <details
      className="flex flex-col gap-3"
      onToggle={(event) => {
        setOpen(event.currentTarget.open);
      }}
    >
      <summary className="flex min-h-11 cursor-pointer items-center text-small font-semibold">
        {t("issues.conversation.openOwn", { type: issue.typeName })}
      </summary>
      {open ? (
        <Thread issue={issue} onChanged={onChanged} onFollowUp={onFollowUp} />
      ) : null}
    </details>
  );
}

function Thread({
  issue,
  onChanged,
  onFollowUp,
}: {
  issue: OwnIssue;
  onChanged: () => void;
  onFollowUp: (refusedReply: string) => void;
}): ReactElement {
  const { t, i18n } = useTranslation();
  /*
   * The reply the server refused as closed. Past the reopening window the
   * field gives way to the follow-up button and its draft goes with it, so
   * the text is kept here, in the thread that outlives the field.
   */
  const [refusedReply, setRefusedReply] = useState("");
  const [messages, setMessages] = useState<OwnIssueMessage[] | null>(null);
  const [readFailed, setReadFailed] = useState(false);
  /** Bumped after a send, which reads the conversation again. */
  const [reads, setReads] = useState(0);

  useEffect(() => {
    let active = true;
    void fetchOwnIssueMessages(issue.id).then((read) => {
      if (!active) {
        return;
      }
      if (read.ok) {
        setMessages(read.value);
        setReadFailed(false);
      } else {
        // The list on screen is kept, and said to be possibly out of date.
        setReadFailed(true);
      }
    });
    return () => {
      active = false;
    };
  }, [issue.id, reads]);

  return (
    <div className="flex flex-col gap-3 pt-2">
      {readFailed ? (
        <Notice tone="danger" live>
          {t("issues.conversation.readFailed")}
        </Notice>
      ) : null}

      {messages === null ? (
        readFailed ? null : (
          <p role="status" className={HINT}>
            {t("issues.conversation.loading")}
          </p>
        )
      ) : messages.length === 0 ? (
        <p className={HINT}>{t("issues.conversation.emptyOwn")}</p>
      ) : (
        <ol className="flex flex-col gap-2">
          {messages.map((message) => (
            <li
              key={message.id}
              className="flex flex-col gap-1 rounded-control border border-line px-3 py-2"
            >
              <span className="flex flex-wrap gap-x-3 text-small">
                <span className="font-semibold">
                  {message.side === "HANDLER"
                    ? t(ISSUE_SIGNATURE_LABEL[message.signature])
                    : t("issues.conversation.you")}
                </span>
                <span className="font-data text-data text-ink-muted">
                  {formatMoment(message.createdAt, i18n.language)}
                </span>
              </span>
              <ConversationText
                body={message.body}
                redactedAt={message.redactedAt}
              />
            </li>
          ))}
        </ol>
      )}

      {issue.replyMode === "NEW_REPORT" ? (
        <div className="flex flex-col gap-2">
          <p className={HINT}>
            {issue.mergedIntoMeaning === null
              ? t("issues.conversation.closedOwn")
              : t("issues.conversation.mergedOwn")}
          </p>
          <div>
            <button
              type="button"
              className={SECONDARY_BUTTON}
              onClick={() => {
                onFollowUp(refusedReply);
              }}
            >
              {t("issues.conversation.followUp")}
            </button>
          </div>
        </div>
      ) : (
        <ConversationComposer
          label={t("issues.conversation.message")}
          ariaLabel={t("issues.conversation.messageNamed", {
            type: issue.typeName,
          })}
          hint={
            issue.replyMode === "REOPENS"
              ? t("issues.conversation.reopensHint")
              : t("issues.conversation.ownHint")
          }
          sendLabel={t("issues.conversation.send")}
          sendingLabel={t("issues.conversation.sending")}
          failures={REPLY_FAILURES}
          fallback="issues.conversation.errors.unknown"
          send={(body) => sendOwnIssueMessage({ issueId: issue.id, body })}
          onSent={() => {
            setReads((count) => count + 1);
            // A reply may have reopened the issue, as the screen expected or
            // because it closed while the screen was open; the list says so
            // once it is read again.
            onChanged();
          }}
          onRefused={(reason, body) => {
            if (reason === "issue-closed") {
              setRefusedReply(body);
              onChanged();
            }
          }}
        />
      )}
    </div>
  );
}

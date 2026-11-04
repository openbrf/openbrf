import { useEffect, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";

import {
  fetchOwnIssueMessages,
  type OwnIssue,
  type OwnIssueMessage,
  sendOwnIssueMessage,
} from "../api/issues";
import type { TranslationKey } from "../i18n/translation-key";
import { HINT } from "../ui/controls";
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
 * A closed report takes no more messages; what a reply to a closed report does
 * is the reopening rule's (ADR 0054).
 */
export function OwnIssueConversation({
  issue,
  onClosed,
}: {
  issue: OwnIssue;
  /**
   * Told when the server says the report is closed, which the list on screen
   * does not yet know: the caller reads the list again, and the composer gives
   * way to the closed report's notice.
   */
  onClosed: () => void;
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
      {open ? <Thread issue={issue} onClosed={onClosed} /> : null}
    </details>
  );
}

function Thread({
  issue,
  onClosed,
}: {
  issue: OwnIssue;
  onClosed: () => void;
}): ReactElement {
  const { t, i18n } = useTranslation();
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

  const closed = issue.meaning === "DONE";

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

      {closed ? (
        <p className={HINT}>{t("issues.conversation.closedOwn")}</p>
      ) : (
        <ConversationComposer
          label={t("issues.conversation.message")}
          ariaLabel={t("issues.conversation.messageNamed", {
            type: issue.typeName,
          })}
          hint={t("issues.conversation.ownHint")}
          sendLabel={t("issues.conversation.send")}
          sendingLabel={t("issues.conversation.sending")}
          failures={REPLY_FAILURES}
          fallback="issues.conversation.errors.unknown"
          send={(body) => sendOwnIssueMessage({ issueId: issue.id, body })}
          onSent={() => {
            setReads((count) => count + 1);
          }}
          onRefused={(reason) => {
            if (reason === "issue-closed") {
              onClosed();
            }
          }}
        />
      )}
    </div>
  );
}

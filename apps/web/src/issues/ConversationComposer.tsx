import { ISSUE_CONVERSATION_LIMITS } from "@openbrf/shared";
import { useId, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";

import type { ApiResult } from "../api/client";
import type { IssueSavedReply } from "../api/issues";
import type { TranslationKey } from "../i18n/translation-key";
import {
  FIELD,
  FIELD_MULTILINE,
  HINT,
  LABEL,
  PRIMARY_BUTTON,
} from "../ui/controls";
import { Notice } from "../ui/Notice";
import { failureMessageKey, useSaveAction } from "../ui/save-state";

/**
 * The field a message or a note is written in, and its one send.
 *
 * One send in flight, and the draft stays until the server has taken it: a
 * refusal leaves the words in the field to change, and says why until the
 * draft changes. A sent draft is cleared, and only then is the caller told,
 * so the list it re-reads already holds what was sent.
 *
 * With `savedReplies`, a handler can insert one of the association's saved
 * replies (decision 17) into the field. It is inserted, never sent: the
 * handler reads it, adapts it, and sends their own message.
 */
export function ConversationComposer<T>({
  label,
  ariaLabel,
  hint,
  sendLabel,
  sendingLabel,
  failures,
  fallback,
  send,
  onSent,
  onRefused,
  savedReplies,
}: {
  label: string;
  ariaLabel: string;
  hint?: string;
  sendLabel: string;
  sendingLabel: string;
  failures: Readonly<Record<string, TranslationKey>>;
  fallback: TranslationKey;
  send: (body: string) => Promise<ApiResult<T>>;
  onSent: (sent: T) => void;
  /** Told of a refusal, so the caller can read again what it was about. */
  onRefused?: (reason: string) => void;
  savedReplies?: readonly IssueSavedReply[];
}): ReactElement {
  const { t } = useTranslation();
  const [draft, setDraft] = useState("");
  const pickerId = useId();
  const hintId = useId();
  const save = useSaveAction(
    send,
    (sent) => {
      setDraft("");
      onSent(sent);
    },
    (failure) => onRefused?.(failure.reason),
  );
  const busy = save.pending;
  const empty = draft.trim() === "";

  const change = (next: string): void => {
    setDraft(next);
    if (save.state.kind === "failed") {
      save.reset();
    }
  };

  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (!busy && !empty) {
          void save.submit(draft);
        }
      }}
    >
      {save.state.kind === "failed" ? (
        <Notice tone="danger" live>
          {t(failureMessageKey(save.state.failure, failures, fallback))}
        </Notice>
      ) : null}

      {savedReplies !== undefined && savedReplies.length > 0 ? (
        <label className={LABEL} htmlFor={pickerId}>
          {t("issues.conversation.savedReply")}
          <select
            id={pickerId}
            value=""
            disabled={busy}
            onChange={(event) => {
              const picked = savedReplies.find(
                (reply) => reply.id === event.target.value,
              );
              if (picked !== undefined) {
                change(
                  draft.trim() === ""
                    ? picked.body
                    : `${draft.trimEnd()}\n\n${picked.body}`,
                );
              }
            }}
            className={FIELD}
          >
            <option value="">{t("issues.conversation.savedReplyPick")}</option>
            {savedReplies.map((reply) => (
              <option key={reply.id} value={reply.id}>
                {reply.title}
              </option>
            ))}
          </select>
        </label>
      ) : null}

      <label className={LABEL}>
        {label}
        <textarea
          aria-label={ariaLabel}
          aria-describedby={hint === undefined ? undefined : hintId}
          rows={4}
          maxLength={ISSUE_CONVERSATION_LIMITS.body}
          value={draft}
          disabled={busy}
          onChange={(event) => {
            change(event.target.value);
          }}
          className={FIELD_MULTILINE}
        />
      </label>
      {hint === undefined ? null : (
        <p id={hintId} className={HINT}>
          {hint}
        </p>
      )}

      <div>
        <button
          type="submit"
          disabled={busy || empty}
          className={PRIMARY_BUTTON}
        >
          {busy ? sendingLabel : sendLabel}
        </button>
      </div>
    </form>
  );
}

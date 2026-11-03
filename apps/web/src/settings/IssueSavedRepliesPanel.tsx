import { ISSUE_CONVERSATION_LIMITS } from "@openbrf/shared";
import { useEffect, useId, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";

import {
  createIssueSavedReply,
  fetchConfiguredSavedReplies,
  type IssueSavedReply,
  type IssueSavedReplyInput,
  removeIssueSavedReply,
  updateIssueSavedReply,
} from "../api/issues";
import type { TranslationKey } from "../i18n/translation-key";
import {
  FIELD,
  FIELD_MULTILINE,
  HINT,
  LABEL,
  PRIMARY_BUTTON,
  QUIET_BUTTON,
  SECONDARY_BUTTON,
} from "../ui/controls";
import { Notice } from "../ui/Notice";
import { Panel } from "../ui/Panel";
import { failureMessage, useSaveAction } from "../ui/save-state";

const FAILURES: Readonly<Record<string, TranslationKey>> = {
  "saved-reply-not-found": "settings.issueSavedReplies.errors.notFound",
  "too-many-saved-replies": "settings.issueSavedReplies.errors.tooMany",
  "personal-identity-number":
    "settings.issueSavedReplies.errors.personalIdentityNumber",
};

const FIELD_LABELS: Readonly<Record<string, TranslationKey>> = {
  title: "settings.issueSavedReplies.titleLabel",
  body: "settings.issueSavedReplies.bodyLabel",
};

/** One finished read, and which read it answers for (see `IssueTypesPanel`). */
interface Loaded {
  readonly read: number;
  /** Kept through a read that fails, so the board still has its list. */
  readonly replies: readonly IssueSavedReply[] | null;
  readonly failed: boolean;
}

/** One write on the list, so the panel has one in flight at a time. */
type Act =
  | { kind: "create"; values: IssueSavedReplyInput }
  | { kind: "update"; id: string; values: IssueSavedReplyInput }
  | { kind: "remove"; id: string };

function perform(act: Act) {
  switch (act.kind) {
    case "create":
      return createIssueSavedReply(act.values);
    case "update":
      return updateIssueSavedReply({ id: act.id, values: act.values });
    case "remove":
      return removeIssueSavedReply(act.id);
  }
}

/**
 * The association's saved replies (decision 17): texts a handler starts a
 * message to a reporter from.
 *
 * The board's own words, sent in its name, so they are written here under
 * issues:configure and read by everybody who handles issues. Picking one in a
 * conversation fills the field and sends nothing. Two come with a new
 * instance, one of them saying that what was reported is the tenant-owner's
 * under the bylaws; the board rewords them to its own bylaws.
 */
export function IssueSavedRepliesPanel(): ReactElement {
  const { t } = useTranslation();
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [reads, setReads] = useState(0);
  const [draft, setDraft] = useState({ title: "", body: "" });

  useEffect(() => {
    let active = true;
    void fetchConfiguredSavedReplies().then((result) => {
      if (!active) {
        return;
      }
      setLoaded((previous) => ({
        read: reads,
        replies: result.ok ? result.value : (previous?.replies ?? null),
        failed: !result.ok,
      }));
    });
    return () => {
      active = false;
    };
  }, [reads]);

  const save = useSaveAction(
    perform,
    (_value: unknown) => {
      setReads((count) => count + 1);
    },
    () => {
      // A refusal may be about a list that changed elsewhere.
      setReads((count) => count + 1);
    },
  );
  const busy = save.pending;
  const replies = loaded?.replies ?? null;
  const readFailed = loaded !== null && loaded.read === reads && loaded.failed;
  const onDraftChanged = (): void => {
    if (save.state.kind === "failed") {
      save.reset();
    }
  };

  return (
    <Panel
      title={t("settings.issueSavedReplies.title")}
      description={t("settings.issueSavedReplies.description")}
    >
      <div className="flex flex-col gap-4">
        {save.state.kind === "failed" ? (
          <Notice tone="danger" live>
            {failureMessage(
              t,
              save.state.failure,
              FAILURES,
              "settings.issueSavedReplies.errors.unknown",
              FIELD_LABELS,
            )}
          </Notice>
        ) : readFailed ? (
          <Notice tone="danger" live>
            {t("settings.issueSavedReplies.loadFailed")}
          </Notice>
        ) : null}

        {replies === null ? (
          readFailed ? null : (
            <p role="status" className={HINT}>
              {t("settings.issueSavedReplies.loading")}
            </p>
          )
        ) : replies.length === 0 ? (
          <p className={HINT}>{t("settings.issueSavedReplies.empty")}</p>
        ) : (
          <ul className="flex flex-col gap-4">
            {replies.map((reply) => (
              <li key={`${reply.id}:${reply.title}:${reply.body}`}>
                <SavedReplyForm
                  reply={reply}
                  disabled={busy}
                  onDraftChanged={onDraftChanged}
                  onSave={(values) => {
                    void save.submit({ kind: "update", id: reply.id, values });
                  }}
                  onRemove={() => {
                    void save.submit({ kind: "remove", id: reply.id });
                  }}
                />
              </li>
            ))}
          </ul>
        )}

        <form
          className="flex flex-col gap-2 border-t border-line pt-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (draft.title.trim() === "" || draft.body.trim() === "") {
              return;
            }
            void save
              .submit({ kind: "create", values: draft })
              .then((saved) => {
                if (saved) {
                  setDraft({ title: "", body: "" });
                }
              });
          }}
        >
          <h3 className="text-label text-ink-muted uppercase">
            {t("settings.issueSavedReplies.addTitle")}
          </h3>
          <ReplyFields
            title={draft.title}
            body={draft.body}
            disabled={busy}
            onChange={(next) => {
              setDraft(next);
              onDraftChanged();
            }}
          />
          <div>
            <button
              type="submit"
              disabled={
                busy || draft.title.trim() === "" || draft.body.trim() === ""
              }
              className={PRIMARY_BUTTON}
            >
              {busy
                ? t("settings.issueSavedReplies.saving")
                : t("settings.issueSavedReplies.add")}
            </button>
          </div>
        </form>
      </div>
    </Panel>
  );
}

/** One saved reply, with its save offered only for a real change. */
function SavedReplyForm({
  reply,
  disabled,
  onDraftChanged,
  onSave,
  onRemove,
}: {
  reply: IssueSavedReply;
  disabled: boolean;
  onDraftChanged: () => void;
  onSave: (values: IssueSavedReplyInput) => void;
  onRemove: () => void;
}): ReactElement {
  const { t } = useTranslation();
  const [values, setValues] = useState({
    title: reply.title,
    body: reply.body,
  });
  const changed = values.title !== reply.title || values.body !== reply.body;
  const blank = values.title.trim() === "" || values.body.trim() === "";
  return (
    <form
      className="flex flex-col gap-2 rounded-control border border-line px-3 py-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (changed && !blank) {
          onSave({ ...values, sortOrder: reply.sortOrder });
        }
      }}
    >
      <ReplyFields
        title={values.title}
        body={values.body}
        disabled={disabled}
        named={reply.title}
        onChange={(next) => {
          setValues(next);
          onDraftChanged();
        }}
      />
      <div className="flex flex-wrap gap-2">
        <button
          type="submit"
          disabled={disabled || !changed || blank}
          className={SECONDARY_BUTTON}
        >
          {t("settings.issueSavedReplies.save")}
        </button>
        <button
          type="button"
          disabled={disabled}
          className={QUIET_BUTTON}
          aria-label={t("settings.issueSavedReplies.removeNamed", {
            title: reply.title,
          })}
          onClick={onRemove}
        >
          {t("settings.issueSavedReplies.remove")}
        </button>
      </div>
    </form>
  );
}

function ReplyFields({
  title,
  body,
  disabled,
  named,
  onChange,
}: {
  title: string;
  body: string;
  disabled: boolean;
  /** The saved reply's title as stored, which names the fields of a row. */
  named?: string;
  onChange: (next: { title: string; body: string }) => void;
}): ReactElement {
  const { t } = useTranslation();
  const hintId = useId();
  return (
    <>
      <label className={LABEL}>
        {t("settings.issueSavedReplies.titleLabel")}
        <input
          type="text"
          autoComplete="off"
          maxLength={ISSUE_CONVERSATION_LIMITS.savedReplyTitle}
          value={title}
          disabled={disabled}
          aria-label={
            named === undefined
              ? undefined
              : t("settings.issueSavedReplies.titleNamed", { title: named })
          }
          onChange={(event) => {
            onChange({ title: event.target.value, body });
          }}
          className={FIELD}
        />
      </label>
      <label className={LABEL}>
        {t("settings.issueSavedReplies.bodyLabel")}
        <textarea
          rows={4}
          maxLength={ISSUE_CONVERSATION_LIMITS.body}
          value={body}
          disabled={disabled}
          aria-label={
            named === undefined
              ? undefined
              : t("settings.issueSavedReplies.bodyNamed", { title: named })
          }
          aria-describedby={hintId}
          onChange={(event) => {
            onChange({ title, body: event.target.value });
          }}
          className={FIELD_MULTILINE}
        />
      </label>
      <p id={hintId} className={HINT}>
        {t("settings.issueSavedReplies.bodyHint")}
      </p>
    </>
  );
}

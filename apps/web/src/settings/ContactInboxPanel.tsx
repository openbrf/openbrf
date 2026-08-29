import { useEffect, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";

import type { ContactSubmission } from "../api/contact";
import {
  fetchContactSubmissions,
  setContactSubmissionHandled,
} from "../api/contact";
import type { TranslationKey } from "../i18n/translation-key";
import { QUIET_BUTTON, SECONDARY_BUTTON } from "../ui/controls";
import { Notice } from "../ui/Notice";
import { Panel } from "../ui/Panel";
import { failureMessageKey, useSaveAction } from "../ui/save-state";

/** Everything one load produces, applied to the panel in one step. */
interface Loaded {
  ready: boolean;
  submissions: readonly ContactSubmission[];
  loadFailed: boolean;
}

const EMPTY: Loaded = { ready: false, submissions: [], loadFailed: false };

const UPDATE_FAILURES: Readonly<Record<string, TranslationKey>> = {
  // Reachable without anybody doing anything wrong: service-tier data is
  // purgeable, so a message can be gone by the time it is ticked off.
  "not-found": "settings.contactInbox.errors.notFound",
};

async function read(): Promise<Loaded> {
  const result = await fetchContactSubmissions();
  return {
    ready: true,
    submissions: result.ok ? result.value : [],
    /*
     * Named rather than rendered as an empty inbox. The two look identical and
     * mean opposite things: "nobody has written" invites the board to close the
     * screen, while a failed read means somebody may have been waiting for days
     * behind an error nobody was shown.
     */
    loadFailed: !result.ok,
  };
}

/**
 * What the public has written to the board through the website.
 *
 * The other end of a form the board never sees the code of: it is server-
 * rendered on the association's own website, has no JavaScript in it and is
 * submitted by a plain HTML post. This panel is the record. A message is stored
 * before the board is emailed about it, so a message appears here whether or
 * not the notification could be delivered - which is the whole reason the
 * inbox exists rather than the form simply forwarding to an address.
 *
 * Beside the sign-up queue and gated on the same capability, because it is the
 * same board work: the two inbound queues an anonymous visitor can put
 * something in.
 */
export function ContactInboxPanel(): ReactElement {
  const { t } = useTranslation();
  const [loaded, setLoaded] = useState<Loaded>(EMPTY);
  const [pendingId, setPendingId] = useState<string | null>(null);

  const update = useSaveAction(setContactSubmissionHandled);

  useEffect(() => {
    // The effect owns its own call and drops an answer that arrives after the
    // panel is gone.
    let active = true;
    void read().then((next) => {
      if (active) {
        setLoaded(next);
      }
    });
    return () => {
      active = false;
    };
  }, []);

  const onToggle = (submission: ContactSubmission): void => {
    setPendingId(submission.id);
    void update.submit(submission.id, !submission.handled).then(() => {
      setPendingId(null);
      // Read again whichever way it went. A refusal here usually means the list
      // in front of the board is out of date, and leaving the old row on screen
      // would invite them to press the same button again.
      void read().then(setLoaded);
    });
  };

  const failure = update.state.kind === "failed" ? update.state.failure : null;
  const { ready, submissions, loadFailed } = loaded;

  /*
   * Four states, and the third one renders nothing on purpose: the notice above
   * has already said the list could not be read, and "no messages have arrived"
   * underneath it would be the sentence that reads wrongly.
   */
  const body = !ready ? (
    <p role="status" className="text-small text-ink-muted">
      {t("settings.contactInbox.loading")}
    </p>
  ) : loadFailed ? null : submissions.length === 0 ? (
    <p className="text-small text-ink-muted">
      {t("settings.contactInbox.empty")}
    </p>
  ) : (
    <ul className="flex flex-col gap-5">
      {submissions.map((submission) => (
        <MessageRow
          key={submission.id}
          submission={submission}
          busy={pendingId !== null}
          saving={pendingId === submission.id}
          onToggle={() => {
            onToggle(submission);
          }}
        />
      ))}
    </ul>
  );

  return (
    <Panel
      title={t("settings.contactInbox.title")}
      description={t("settings.contactInbox.description")}
      notice={
        <>
          {loadFailed ? (
            <Notice tone="danger">
              {t("settings.contactInbox.loadFailed")}
            </Notice>
          ) : null}

          {failure === null ? null : (
            <Notice tone="danger" live>
              {t(
                failureMessageKey(
                  failure,
                  UPDATE_FAILURES,
                  "settings.contactInbox.errors.unknown",
                ),
              )}
            </Notice>
          )}
        </>
      }
    >
      {body}
    </Panel>
  );
}

/** One message, with the one decision the board has to make about it. */
function MessageRow({
  submission,
  busy,
  saving,
  onToggle,
}: {
  submission: ContactSubmission;
  /** Any row is being updated. */
  busy: boolean;
  /** This row is the one being updated. */
  saving: boolean;
  onToggle: () => void;
}): ReactElement {
  const { t } = useTranslation();

  return (
    <li className="flex flex-col gap-3 border-t border-line pt-5 first:border-t-0 first:pt-0">
      <div className="flex flex-col gap-1">
        <h3 className="text-title">
          {submission.name ?? t("settings.contactInbox.anonymous")}
        </h3>
        <p className="text-small text-ink-muted">{submission.email}</p>
      </div>

      <p className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="text-label text-ink-muted uppercase">
          {t("settings.contactInbox.receivedOn")}
        </span>
        {/* The day rather than the timestamp: the inbox is read to see how long
            somebody has been waiting, and a date belongs on the mono grid like
            every other date in the interface. */}
        <span className="font-data text-data text-ink-muted">
          {submission.createdAt.slice(0, 10)}
        </span>
        {submission.handledAt === null ? null : (
          <>
            <span className="text-label text-ink-muted uppercase">
              {t("settings.contactInbox.handledOn")}
            </span>
            <span className="font-data text-data text-ink-muted">
              {submission.handledAt.slice(0, 10)}
            </span>
          </>
        )}
      </p>

      {/* Verbatim, and never trimmed on the way to the screen: the board is
          reading what a person wrote to them. The line breaks are theirs. */}
      <p className="text-body whitespace-pre-wrap text-ink">
        {submission.message}
      </p>

      <div>
        <button
          type="button"
          disabled={busy}
          onClick={onToggle}
          className={submission.handled ? QUIET_BUTTON : SECONDARY_BUTTON}
        >
          {saving
            ? t("settings.contactInbox.saving")
            : submission.handled
              ? t("settings.contactInbox.markUnhandled")
              : t("settings.contactInbox.markHandled")}
        </button>
      </div>
    </li>
  );
}

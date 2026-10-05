import { useEffect, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";

import type { ContactSubmission } from "../api/contact";
import {
  deleteContactSubmission,
  deleteContactSubmissions,
  fetchContactSubmissions,
  setContactSubmissionHandled,
} from "../api/contact";
import { localDayOfInstant } from "../bookings/booking-calendar";
import type { TranslationKey } from "../i18n/translation-key";
import {
  CAUTION_BUTTON,
  HINT,
  QUIET_BUTTON,
  SECONDARY_BUTTON,
} from "../ui/controls";
import { Notice } from "../ui/Notice";
import { PlaceOnPage } from "../site-admin/PlaceOnPage";
import { Panel } from "../ui/Panel";
import { failureMessageKey, useSaveAction } from "../ui/save-state";

/** Everything one load produces, applied to the panel in one step. */
interface Loaded {
  ready: boolean;
  submissions: readonly ContactSubmission[];
  unhandled: number;
  total: number;
  /** Where the next page starts, or null when everything is shown. */
  nextCursor: string | null;
  loadFailed: boolean;
}

const EMPTY: Loaded = {
  ready: false,
  submissions: [],
  unhandled: 0,
  total: 0,
  nextCursor: null,
  loadFailed: false,
};

const UPDATE_FAILURES: Readonly<Record<string, TranslationKey>> = {
  // Reachable without anybody doing anything wrong: service-tier data is
  // purgeable, so a message can be gone by the time it is ticked off.
  "not-found": "settings.contactInbox.errors.notFound",
};

/**
 * The first page, or the next one appended to what is already shown.
 *
 * Paged, and counted, so a burst of messages cannot hide the ones behind it:
 * the board sees how many are waiting and can read on past any number of them.
 */
async function read(shown?: Loaded): Promise<Loaded> {
  const result = await fetchContactSubmissions(shown?.nextCursor ?? undefined);
  if (!result.ok && shown !== undefined) {
    return { ...shown, loadFailed: true };
  }
  return {
    ready: true,
    submissions: result.ok
      ? [...(shown?.submissions ?? []), ...result.value.submissions]
      : [],
    unhandled: result.ok ? result.value.unhandled : 0,
    total: result.ok ? result.value.total : 0,
    nextCursor: result.ok ? result.value.nextCursor : null,
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
export function ContactInboxPanel({
  canPlaceOnPage = false,
}: {
  /**
   * Whether this panel offers to put the block on a page. Held by the screen
   * rather than read here: placing writes a page, which is `site:manage`, and a
   * board member who has this panel without the website must not be offered a
   * control the server would refuse.
   */
  canPlaceOnPage?: boolean;
}): ReactElement {
  const { t } = useTranslation();
  const [loaded, setLoaded] = useState<Loaded>(EMPTY);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [confirmingMany, setConfirmingMany] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);

  const update = useSaveAction(setContactSubmissionHandled);
  const remove = useSaveAction(deleteContactSubmission);
  const removeMany = useSaveAction(deleteContactSubmissions);

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

  /*
   * Read again whichever way either of these went. A refusal usually means the
   * list in front of the board is out of date - somebody else has already dealt
   * with the message, or removed it - and leaving the old row on screen would
   * invite them to press the same button again.
   */
  const settle = (): void => {
    setPendingId(null);
    setSelected(new Set());
    setConfirmingMany(false);
    void read().then(setLoaded);
  };

  const onShowMore = (): void => {
    setLoadingMore(true);
    void read(loaded).then((next) => {
      setLoaded(next);
      setLoadingMore(false);
    });
  };

  const onSelect = (id: string, on: boolean): void => {
    const next = new Set(selected);
    if (on) {
      next.add(id);
    } else {
      next.delete(id);
    }
    setSelected(next);
    setConfirmingMany(false);
  };

  /*
   * The selection is deleted on a second press, like a single row: there is
   * nothing to recover the messages from, and a selection is easier to get
   * wrong than one row.
   */
  const onRemoveSelected = (): void => {
    if (!confirmingMany) {
      setConfirmingMany(true);
      return;
    }
    update.reset();
    remove.reset();
    setPendingId("selection");
    void removeMany.submit([...selected]).then(settle);
  };

  const onToggle = (submission: ContactSubmission): void => {
    remove.reset();
    removeMany.reset();
    setPendingId(submission.id);
    void update.submit(submission.id, !submission.handled).then(settle);
  };

  const onRemove = (submission: ContactSubmission): void => {
    update.reset();
    removeMany.reset();
    setPendingId(submission.id);
    void remove.submit(submission.id).then(settle);
  };

  const failure =
    update.state.kind === "failed"
      ? update.state.failure
      : remove.state.kind === "failed"
        ? remove.state.failure
        : removeMany.state.kind === "failed"
          ? removeMany.state.failure
          : null;
  const { ready, submissions, unhandled, total, nextCursor, loadFailed } =
    loaded;
  const allSelected =
    submissions.length > 0 && submissions.every((one) => selected.has(one.id));

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
    <div className="flex flex-col gap-5">
      <p className="font-data text-data text-ink-muted">
        {t("settings.contactInbox.counts", { unhandled, total })}
      </p>

      <div className="flex flex-wrap items-center gap-3">
        <label className="flex min-h-11 items-center gap-2 text-small">
          <input
            type="checkbox"
            checked={allSelected}
            disabled={pendingId !== null}
            onChange={(event) => {
              setSelected(
                new Set(
                  event.target.checked ? submissions.map((one) => one.id) : [],
                ),
              );
              setConfirmingMany(false);
            }}
            className="size-4"
          />
          {t("settings.contactInbox.selectAll")}
        </label>

        {selected.size === 0 ? null : (
          <>
            <button
              type="button"
              disabled={pendingId !== null}
              onClick={onRemoveSelected}
              className={CAUTION_BUTTON}
            >
              {pendingId === "selection"
                ? t("settings.contactInbox.deleting")
                : t("settings.contactInbox.deleteSelected", {
                    count: selected.size,
                  })}
            </button>
            {confirmingMany ? (
              <span className={HINT} role="status">
                {t("settings.contactInbox.deleteSelectedHint")}
              </span>
            ) : null}
          </>
        )}
      </div>

      <ul className="flex flex-col gap-5">
        {submissions.map((submission) => (
          <MessageRow
            key={submission.id}
            submission={submission}
            busy={pendingId !== null}
            saving={pendingId === submission.id}
            selected={selected.has(submission.id)}
            onSelect={(on) => {
              onSelect(submission.id, on);
            }}
            onToggle={() => {
              onToggle(submission);
            }}
            onRemove={() => {
              onRemove(submission);
            }}
          />
        ))}
      </ul>

      {nextCursor === null ? null : (
        <button
          type="button"
          disabled={loadingMore || pendingId !== null}
          onClick={onShowMore}
          className={`${SECONDARY_BUTTON} self-start`}
        >
          {loadingMore
            ? t("settings.contactInbox.loadingMore")
            : t("settings.contactInbox.showMore")}
        </button>
      )}
    </div>
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

      {canPlaceOnPage ? (
        <PlaceOnPage
          block={{ type: "contactForm" }}
          titleKey="siteAdmin.place.contactForm.title"
          descriptionKey="siteAdmin.place.contactForm.description"
          alreadyThereKey="siteAdmin.place.contactForm.alreadyThere"
        />
      ) : null}
    </Panel>
  );
}

/** One message, with the one decision the board has to make about it. */
function MessageRow({
  submission,
  busy,
  saving,
  selected,
  onSelect,
  onToggle,
  onRemove,
}: {
  submission: ContactSubmission;
  /** Any row is being updated. */
  busy: boolean;
  /** This row is the one being updated. */
  saving: boolean;
  /** This row is among those picked for removal together. */
  selected: boolean;
  onSelect: (selected: boolean) => void;
  onToggle: () => void;
  onRemove: () => void;
}): ReactElement {
  const { t } = useTranslation();
  /*
   * Removing asks first, in the row rather than in a dialog.
   *
   * There is nothing behind this to recover a message from, and the board is
   * deleting somebody else's words about their own situation. A second press
   * is the smallest thing that stops a mis-aimed one.
   */
  const [confirming, setConfirming] = useState(false);

  return (
    <li className="flex flex-col gap-3 border-t border-line pt-5 first:border-t-0 first:pt-0">
      <label className="flex min-h-11 items-center gap-2 text-small">
        <input
          type="checkbox"
          checked={selected}
          disabled={busy}
          onChange={(event) => {
            onSelect(event.target.checked);
          }}
          className="size-4"
        />
        {t("settings.contactInbox.select")}
      </label>
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
          {localDayOfInstant(submission.createdAt)}
        </span>
        {submission.handledAt === null ? null : (
          <>
            <span className="text-label text-ink-muted uppercase">
              {t("settings.contactInbox.handledOn")}
            </span>
            <span className="font-data text-data text-ink-muted">
              {localDayOfInstant(submission.handledAt)}
            </span>
          </>
        )}
      </p>

      {/* Verbatim, and never trimmed on the way to the screen: the board is
          reading what a person wrote to them. The line breaks are theirs. */}
      <p className="text-body whitespace-pre-wrap text-ink">
        {submission.message}
      </p>

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            // Reaching for the other action is a change of mind about deleting.
            setConfirming(false);
            onToggle();
          }}
          className={submission.handled ? QUIET_BUTTON : SECONDARY_BUTTON}
        >
          {saving
            ? t("settings.contactInbox.saving")
            : submission.handled
              ? t("settings.contactInbox.markUnhandled")
              : t("settings.contactInbox.markHandled")}
        </button>

        <button
          type="button"
          disabled={busy}
          onClick={() => {
            if (confirming) {
              onRemove();
              return;
            }
            setConfirming(true);
          }}
          className={QUIET_BUTTON}
        >
          {saving && confirming
            ? t("settings.contactInbox.deleting")
            : t("settings.contactInbox.delete")}
        </button>

        {/* Only once the board has reached for it, so a row is not a wall of
            caution before anybody asked to delete anything. Words rather than
            colour: this sentence is the whole signal. */}
        {confirming ? (
          <span className={HINT} role="status">
            {t("settings.contactInbox.deleteHint")}
          </span>
        ) : null}
      </div>
    </li>
  );
}

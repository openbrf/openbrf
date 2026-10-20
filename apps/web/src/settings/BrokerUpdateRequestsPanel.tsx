import { useEffect, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";

import {
  type BrokerUpdateRequest,
  type BrokerUpdateRequestQueue,
  dismissBrokerUpdateRequest,
  fetchBrokerUpdateRequests,
} from "../api/broker-update-requests";
import { localDayOfInstant } from "../bookings/booking-calendar";
import type { TranslationKey } from "../i18n/translation-key";
import { HINT, QUIET_BUTTON } from "../ui/controls";
import { Notice } from "../ui/Notice";
import { Panel } from "../ui/Panel";
import { failureMessageKey, useSaveAction } from "../ui/save-state";

/** What one read produces, applied to the panel in one step. */
type Loaded =
  | { kind: "loading" }
  | { kind: "failed" }
  | {
      kind: "ready";
      queue: BrokerUpdateRequestQueue;
      /**
       * Reading the list again after a dismissal failed, so what is shown is
       * the list from before it and may no longer be true.
       */
      outdated: boolean;
    };

const DISMISS_FAILURES: Readonly<Record<string, TranslationKey>> = {
  // Reachable without anybody doing anything wrong: another board member, or
  // the nightly purge, may have removed it since the list was read.
  "not-found": "settings.brokerUpdateRequests.errors.notFound",
};

async function read(): Promise<Loaded> {
  const result = await fetchBrokerUpdateRequests();
  return result.ok
    ? { kind: "ready", queue: result.value, outdated: false }
    : { kind: "failed" };
}

/**
 * Brokers' requests for the board to look at the facts on the broker page.
 *
 * The other end of a form the board never sees: a plain post from the
 * association's broker page, offered once the facts are older than the board's
 * threshold. What the board does about a request is not done here. It looks
 * at the facts on the website's screen and confirms or corrects them, and that
 * answers every open request at once - so this panel is the list of who asked,
 * and the one thing it can do is dismiss a request that is not one.
 *
 * Beside the contact inbox, because it is the same kind of work: something a
 * stranger put in the instance from the street. Shown to whoever holds
 * site:manage, the capability that confirms the facts and so answers the
 * request.
 */
export function BrokerUpdateRequestsPanel(): ReactElement {
  const { t } = useTranslation();
  const [loaded, setLoaded] = useState<Loaded>({ kind: "loading" });
  const [pendingId, setPendingId] = useState<string | null>(null);
  const dismiss = useSaveAction(dismissBrokerUpdateRequest);

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
   * Read again whichever way the dismissal went. A refusal means the list is
   * out of date, and leaving the row on screen would invite the same press
   * again. The panel stays busy until the list is back.
   *
   * A read that fails keeps the list that was shown rather than claiming the
   * queue is empty, and says it may be out of date: the dismissal may have
   * gone through, and the row still on screen is then a request that is no
   * longer there.
   */
  const onDismiss = (request: BrokerUpdateRequest): void => {
    setPendingId(request.id);
    void dismiss.submit(request.id).then(async () => {
      const next = await read();
      setLoaded((shown) =>
        next.kind === "failed" && shown.kind === "ready"
          ? { ...shown, outdated: true }
          : next,
      );
      setPendingId(null);
    });
  };

  const failure =
    dismiss.state.kind === "failed" ? dismiss.state.failure : null;
  const busy = pendingId !== null;

  const body =
    loaded.kind === "loading" ? (
      <p role="status" className="text-small text-ink-muted">
        {t("settings.brokerUpdateRequests.loading")}
      </p>
    ) : loaded.kind === "failed" ? null : (
      <div className="flex flex-col gap-8">
        <section className="flex flex-col gap-4">
          <h3 className="text-title">
            {t("settings.brokerUpdateRequests.openHeading")}
          </h3>
          {loaded.queue.open.length === 0 ? (
            <p className="text-small text-ink-muted">
              {t("settings.brokerUpdateRequests.noneOpen")}
            </p>
          ) : (
            <>
              {loaded.queue.openTotal > loaded.queue.open.length ? (
                <p className="font-data text-data text-ink-muted">
                  {t("settings.brokerUpdateRequests.showingOldest", {
                    shown: loaded.queue.open.length,
                    total: loaded.queue.openTotal,
                  })}
                </p>
              ) : null}
              <RequestList
                requests={loaded.queue.open}
                busy={busy}
                pendingId={pendingId}
                onDismiss={onDismiss}
              />
            </>
          )}
        </section>

        {loaded.queue.answered.length === 0 ? null : (
          <section className="flex flex-col gap-4">
            <h3 className="text-title">
              {t("settings.brokerUpdateRequests.answeredHeading")}
            </h3>
            <p className="text-small text-ink-muted">
              {t("settings.brokerUpdateRequests.answeredHint")}
            </p>
            <RequestList
              requests={loaded.queue.answered}
              busy={busy}
              pendingId={pendingId}
              onDismiss={onDismiss}
            />
          </section>
        )}
      </div>
    );

  return (
    <Panel
      title={t("settings.brokerUpdateRequests.title")}
      description={t("settings.brokerUpdateRequests.description")}
      notice={
        <>
          {loaded.kind === "failed" ? (
            <Notice tone="danger">
              {t("settings.brokerUpdateRequests.loadFailed")}
            </Notice>
          ) : null}
          {loaded.kind === "ready" && loaded.outdated ? (
            <Notice tone="danger" live>
              {t("settings.brokerUpdateRequests.outdated")}
            </Notice>
          ) : null}
          {failure === null ? null : (
            <Notice tone="danger" live>
              {t(
                failureMessageKey(
                  failure,
                  DISMISS_FAILURES,
                  "settings.brokerUpdateRequests.errors.unknown",
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

function RequestList({
  requests,
  busy,
  pendingId,
  onDismiss,
}: {
  requests: readonly BrokerUpdateRequest[];
  busy: boolean;
  pendingId: string | null;
  onDismiss: (request: BrokerUpdateRequest) => void;
}): ReactElement {
  return (
    <ul className="flex flex-col gap-5">
      {requests.map((request) => (
        <RequestRow
          key={request.id}
          request={request}
          busy={busy}
          dismissing={pendingId === request.id}
          onDismiss={() => {
            onDismiss(request);
          }}
        />
      ))}
    </ul>
  );
}

/** One request: who asked, about which apartment, and how to reach them. */
function RequestRow({
  request,
  busy,
  dismissing,
  onDismiss,
}: {
  request: BrokerUpdateRequest;
  busy: boolean;
  dismissing: boolean;
  onDismiss: () => void;
}): ReactElement {
  const { t } = useTranslation();
  /*
   * Dismissing asks first, in the row rather than in a dialog: it deletes the
   * broker's details, and there is nothing to recover them from.
   */
  const [confirming, setConfirming] = useState(false);

  return (
    <li className="flex flex-col gap-3 border-t border-line pt-5 first:border-t-0 first:pt-0">
      <div className="flex flex-col gap-1">
        <h4 className="text-title">
          {request.name ?? t("settings.brokerUpdateRequests.anonymous")}
        </h4>
        {request.brokerage === null ? null : (
          <p className="text-small text-ink-muted">{request.brokerage}</p>
        )}
        <p className="text-small text-ink-muted">{request.email}</p>
      </div>

      <dl className="grid grid-cols-[auto_1fr] items-baseline gap-x-4 gap-y-1">
        {/* The broker's own text, never looked up in the register: the form
            answers the same for a number the association has and one it
            does not, and so does this screen. */}
        <dt className="text-label text-ink-muted uppercase">
          {t("settings.brokerUpdateRequests.apartment")}
        </dt>
        <dd
          className={
            request.apartmentReference === null
              ? "text-small text-ink-muted"
              : "font-data text-data text-ink"
          }
        >
          {request.apartmentReference ??
            t("settings.brokerUpdateRequests.noApartment")}
        </dd>

        <dt className="text-label text-ink-muted uppercase">
          {t("settings.brokerUpdateRequests.receivedOn")}
        </dt>
        <dd className="font-data text-data text-ink-muted">
          {localDayOfInstant(request.createdAt)}
        </dd>

        {request.answeredAt === null ? null : (
          <>
            <dt className="text-label text-ink-muted uppercase">
              {t("settings.brokerUpdateRequests.answeredOn")}
            </dt>
            <dd className="font-data text-data text-ink-muted">
              {localDayOfInstant(request.answeredAt)}
            </dd>
          </>
        )}
      </dl>

      {/* Verbatim: the board is reading what the broker wrote to them. */}
      {request.note === null ? null : (
        <p className="text-body whitespace-pre-wrap text-ink">{request.note}</p>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            if (confirming) {
              onDismiss();
              return;
            }
            setConfirming(true);
          }}
          className={QUIET_BUTTON}
        >
          {dismissing
            ? t("settings.brokerUpdateRequests.dismissing")
            : t("settings.brokerUpdateRequests.dismiss")}
        </button>
        {/* Words rather than colour: this sentence is the whole signal. */}
        {confirming ? (
          <span className={HINT} role="status">
            {t("settings.brokerUpdateRequests.dismissHint")}
          </span>
        ) : null}
      </div>
    </li>
  );
}

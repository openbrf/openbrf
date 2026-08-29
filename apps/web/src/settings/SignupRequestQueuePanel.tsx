import { useCallback, useEffect, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";

import type { AddressView, ApartmentView } from "../api/instance";
import { fetchApartments } from "../api/instance";
import type { PendingSignupRequest } from "../api/signup";
import {
  approveSignupRequest,
  fetchSignupRequests,
  rejectSignupRequest,
} from "../api/signup";
import type { TranslationKey } from "../i18n/translation-key";
import {
  FIELD,
  FIELD_DATA,
  LABEL,
  QUIET_BUTTON,
  SECONDARY_BUTTON,
} from "../ui/controls";
import { Notice } from "../ui/Notice";
import { Panel } from "../ui/Panel";
import { failureMessageKey, useSaveAction } from "../ui/save-state";

export interface SignupRequestQueuePanelProps {
  /** The register's addresses, already loaded by the settings screen. */
  addresses: readonly AddressView[];
}

/** Everything one load produces, applied to the panel in one step. */
interface Loaded {
  ready: boolean;
  requests: readonly PendingSignupRequest[];
  loadFailed: boolean;
}

/** Which request is being decided, and which way. */
interface Pending {
  id: string;
  kind: "approve" | "reject";
}

type Outcome = { kind: "approved"; email: string } | { kind: "rejected" };

const DECISION_FAILURES: Readonly<Record<string, TranslationKey>> = {
  "already-decided": "settings.signupQueue.errors.alreadyDecided",
  // Reachable without anybody doing anything wrong: a second request from the
  // same address replaces the first, so the id the board is looking at can be
  // gone by the time they decide it.
  "not-found": "settings.signupQueue.errors.notFound",
  "apartment-not-found": "settings.signupQueue.errors.apartmentNotFound",
  // Not a failed approval. The person, the residency and the invitation are
  // written before the email is sent, so this says the account exists and the
  // letter did not go out.
  "mail-not-configured": "settings.signupQueue.errors.mailNotConfigured",
};

const EMPTY: Loaded = { ready: false, requests: [], loadFailed: false };

async function read(): Promise<Loaded> {
  const result = await fetchSignupRequests();
  return {
    ready: true,
    requests: result.ok ? result.value : [],
    /*
     * Named rather than rendered as an empty queue. The two look identical and
     * mean opposite things: "nobody is waiting" invites the board to close the
     * screen, while a failed read means somebody may have been waiting for
     * days behind an error nobody was shown.
     */
    loadFailed: !result.ok,
  };
}

/**
 * The board's queue of sign-up requests.
 *
 * A request is free text - the applicant typed an address and an apartment
 * number, because the public form must not enumerate the register before
 * sign-in (decision 28) - so the claim is rendered exactly as it was written
 * and the board picks the real apartment beside it. That pairing is the whole
 * screen: a human who knows the building decides whether the claim is
 * plausible, and only then does anything get created.
 *
 * Approving sends no role. The API records a resident, and a self-signup never
 * grants membership: holding a tenant-ownership is a matter of record, written
 * by the move-in and register flows, not something granted by asking for it.
 */
export function SignupRequestQueuePanel({
  addresses,
}: SignupRequestQueuePanelProps): ReactElement {
  const { t } = useTranslation();
  const [loaded, setLoaded] = useState<Loaded>(EMPTY);
  const [pending, setPending] = useState<Pending | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  const approve = useSaveAction(approveSignupRequest);
  const reject = useSaveAction(rejectSignupRequest);

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

  const reload = (): void => {
    void read().then(setLoaded);
  };

  /*
   * The queue is read again after every decision, refused ones included, and
   * that is not tidiness. A refusal here usually means the list in front of the
   * board is out of date - somebody else decided the request, or the applicant
   * resubmitted and replaced it - and a refused approval that reports
   * mail-not-configured has already created the person, the residency and the
   * invitation. Leaving the row on screen after any of those would invite the
   * board to decide it a second time.
   */
  const settle = (decided: boolean, next: Outcome): void => {
    setPending(null);
    if (decided) {
      setOutcome(next);
    }
    reload();
  };

  const onApprove = (request: PendingSignupRequest, apartmentId: string) => {
    reject.reset();
    setOutcome(null);
    setPending({ id: request.id, kind: "approve" });
    void approve
      .submit(request.id, { apartmentId })
      .then((decided) =>
        settle(decided, { kind: "approved", email: request.email }),
      );
  };

  const onReject = (request: PendingSignupRequest, reason: string) => {
    approve.reset();
    setOutcome(null);
    setPending({ id: request.id, kind: "reject" });
    const written = reason.trim();
    void reject
      .submit(request.id, written === "" ? {} : { reason: written })
      .then((decided) => settle(decided, { kind: "rejected" }));
  };

  const failure =
    approve.state.kind === "failed"
      ? approve.state.failure
      : reject.state.kind === "failed"
        ? reject.state.failure
        : null;

  const { ready, requests, loadFailed } = loaded;

  return (
    <Panel
      title={t("settings.signupQueue.title")}
      description={t("settings.signupQueue.description")}
      notice={
        <>
          {loadFailed ? (
            <Notice tone="danger">
              {t("settings.signupQueue.loadFailed")}
            </Notice>
          ) : null}

          {failure !== null ? (
            <Notice tone="danger" live>
              {t(
                failureMessageKey(
                  failure,
                  DECISION_FAILURES,
                  "settings.signupQueue.errors.unknown",
                ),
              )}
            </Notice>
          ) : outcome === null ? null : (
            <Notice tone="ok" live>
              {outcome.kind === "approved"
                ? t("settings.signupQueue.approved", { email: outcome.email })
                : t("settings.signupQueue.rejected")}
            </Notice>
          )}
        </>
      }
    >
      {!ready ? (
        <p role="status" className="text-small text-ink-muted">
          {t("settings.signupQueue.loading")}
        </p>
      ) : requests.length === 0 ? (
        <p className="text-small text-ink-muted">
          {t("settings.signupQueue.empty")}
        </p>
      ) : (
        <ul className="flex flex-col gap-5">
          {requests.map((request) => (
            <RequestRow
              key={request.id}
              request={request}
              addresses={addresses}
              busy={pending !== null}
              deciding={pending?.id === request.id ? pending.kind : null}
              onApprove={(apartmentId) => {
                onApprove(request, apartmentId);
              }}
              onReject={(reason) => {
                onReject(request, reason);
              }}
            />
          ))}
        </ul>
      )}
    </Panel>
  );
}

/**
 * One waiting request, with the two decisions beside it.
 *
 * The address and apartment selects hold their state here rather than in the
 * panel, so a board member can open one request's apartment list without
 * disturbing the choice they had already made on another.
 */
function RequestRow({
  request,
  addresses,
  busy,
  deciding,
  onApprove,
  onReject,
}: {
  request: PendingSignupRequest;
  addresses: readonly AddressView[];
  /** Any decision is in flight, anywhere in the queue. */
  busy: boolean;
  /** This row's own decision, when it is the one in flight. */
  deciding: "approve" | "reject" | null;
  onApprove: (apartmentId: string) => void;
  onReject: (reason: string) => void;
}): ReactElement {
  const { t } = useTranslation();

  /*
   * Derived rather than corrected by an effect: an address list that arrives
   * after the first render, or one whose selected entry has just been removed,
   * would otherwise leave the select pointing at nothing until a second render
   * fixed it.
   */
  const [chosenAddressId, setChosenAddressId] = useState<string | null>(null);
  const addressId =
    chosenAddressId !== null &&
    addresses.some((address) => address.id === chosenAddressId)
      ? chosenAddressId
      : (addresses[0]?.id ?? "");

  const [apartments, setApartments] = useState<readonly ApartmentView[]>([]);
  const [apartmentId, setApartmentId] = useState("");
  const [reason, setReason] = useState("");

  const readApartments = useCallback(async (): Promise<
    readonly ApartmentView[]
  > => {
    if (addressId === "") {
      return [];
    }
    const result = await fetchApartments(addressId);
    return result.ok ? result.value : [];
  }, [addressId]);

  useEffect(() => {
    // Guarded so a list for an address the board has already moved away from
    // cannot overwrite the one they are looking at.
    let active = true;
    void readApartments().then((rows) => {
      if (active) {
        setApartments(rows);
        // The chosen apartment belonged to the previous address.
        setApartmentId("");
      }
    });
    return () => {
      active = false;
    };
  }, [readApartments]);

  return (
    <li className="flex flex-col gap-3 border-t border-line pt-5 first:border-t-0 first:pt-0">
      <div className="flex flex-col gap-1">
        <h3 className="text-title">{`${request.firstName} ${request.lastName}`}</h3>
        <p className="text-small text-ink-muted">{request.email}</p>
      </div>

      {/* Verbatim, and never corrected on the way to the screen: what the
          applicant wrote is the thing the board is matching against the
          register by eye. */}
      <p className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="text-label text-ink-muted uppercase">
          {t("settings.signupQueue.claimedLabel")}
        </span>
        <span className="text-body text-ink">{request.claimedAddress}</span>
        <span className="font-data text-data text-ink">
          {request.claimedApartmentNumber}
        </span>
      </p>

      <p className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="text-label text-ink-muted uppercase">
          {t("settings.signupQueue.requestedOn")}
        </span>
        {/* The day rather than the timestamp: the queue is read to see how
            long somebody has been waiting, and a date belongs on the mono
            grid like every other date in the interface. */}
        <span className="font-data text-data text-ink-muted">
          {request.createdAt.slice(0, 10)}
        </span>
      </p>

      <div className="flex flex-wrap items-end gap-3">
        <label className={`${LABEL} min-w-40 flex-1`}>
          {t("settings.signupQueue.selectAddress")}
          <select
            value={addressId}
            disabled={busy}
            onChange={(event) => {
              setChosenAddressId(event.target.value);
            }}
            className={FIELD}
          >
            {addresses.map((address) => (
              <option key={address.id} value={address.id}>
                {`${address.street} ${address.number}`}
              </option>
            ))}
          </select>
        </label>

        <label className={`${LABEL} min-w-40 flex-1`}>
          {t("settings.signupQueue.selectApartment")}
          <select
            value={apartmentId}
            disabled={busy}
            onChange={(event) => {
              setApartmentId(event.target.value);
            }}
            className={FIELD_DATA}
          >
            {/* Named rather than blank: it says what the disabled approve
                button is waiting for. */}
            <option value="">
              {t("settings.signupQueue.apartmentRequired")}
            </option>
            {apartments.map((apartment) => (
              <option key={apartment.id} value={apartment.id}>
                {apartment.number}
              </option>
            ))}
          </select>
        </label>

        <button
          type="button"
          /* Nothing to approve a request against until the board has named a
             real apartment: the claim itself is free text and matches nothing
             on its own. */
          disabled={busy || apartmentId === ""}
          onClick={() => {
            onApprove(apartmentId);
          }}
          className={SECONDARY_BUTTON}
        >
          {deciding === "approve"
            ? t("settings.signupQueue.approving")
            : t("settings.signupQueue.approve")}
        </button>
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <label className={`${LABEL} min-w-40 flex-1`}>
          {t("settings.signupQueue.rejectReason")}
          <input
            type="text"
            maxLength={500}
            value={reason}
            disabled={busy}
            onChange={(event) => {
              setReason(event.target.value);
            }}
            className={FIELD}
          />
        </label>

        <button
          type="button"
          disabled={busy}
          onClick={() => {
            onReject(reason);
          }}
          className={QUIET_BUTTON}
        >
          {deciding === "reject"
            ? t("settings.signupQueue.rejecting")
            : t("settings.signupQueue.reject")}
        </button>
      </div>
    </li>
  );
}

import { WORK_ORDER_LIMITS } from "@openbrf/shared";
import { useEffect, useRef, useState, type ReactElement } from "react";
import { Trans, useTranslation } from "react-i18next";

import type { ApiFailure, ApiResult } from "../api/client";
import { fetchViewer } from "../api/instance";
import type { QueuedIssue } from "../api/issues";
import {
  type ChoosablePhoto,
  chooseWorkOrderPhotos,
  type ContractorChoice,
  fetchContractorChoices,
  fetchIssueWorkOrders,
  type IssueWorkOrders as IssueWorkOrdersData,
  issueWorkOrderLink,
  previewWorkOrder,
  revokeWorkOrderLink,
  sendWorkOrder,
  type WorkOrder,
  type WorkOrderAnswer,
  type WorkOrderDeliveryFailure,
  type WorkOrderPreview,
} from "../api/work-orders";
import type { TranslationKey } from "../i18n/translation-key";
import { copyText } from "../ui/clipboard";
import {
  FIELD,
  FIELD_DATA,
  FIELD_MULTILINE,
  HINT,
  LABEL,
  PRIMARY_BUTTON,
  SECONDARY_BUTTON,
} from "../ui/controls";
import { DATA_TAGS } from "../ui/data-tags";
import { formatMoment } from "../ui/moment";
import { Notice } from "../ui/Notice";
import {
  failureMessageKey,
  type SaveState,
  useSaveAction,
} from "../ui/save-state";
import { usePoll } from "../ui/use-poll";
import { RedactedMark } from "./IssueFreeText";
import { IssueHandlerName } from "./IssueHandlerName";
import { type IssueRedactionControl, RedactAct } from "./IssueRedaction";

const WORK_ORDER_FAILURES: Readonly<Record<string, TranslationKey>> = {
  "issue-not-found": "issues.workOrders.errors.issueNotFound",
  "contractor-not-found": "issues.workOrders.errors.contractorNotFound",
  "contractor-without-email": "issues.workOrders.errors.contractorWithoutEmail",
  "work-order-ring-fenced": "issues.workOrders.errors.ringFenced",
  "work-order-identity-number": "issues.workOrders.errors.identityNumber",
  "work-order-empty": "issues.workOrders.errors.empty",
  "work-order-preview-stale": "issues.workOrders.errors.previewStale",
  "work-order-duplicate": "issues.workOrders.errors.duplicate",
  "issue-closed": "issues.workOrders.errors.issueClosed",
  "work-order-budget-spent": "issues.workOrders.errors.budgetSpent",
  "invalid-body": "issues.workOrders.errors.unknown",
};

/** The refusals that mean what the screen shows is out of date. */
const STALE_REASONS: ReadonlySet<string> = new Set([
  "issue-not-found",
  "contractor-not-found",
  "contractor-without-email",
  "work-order-ring-fenced",
  "work-order-preview-stale",
  "work-order-duplicate",
  "issue-closed",
]);

/** The refusals of a contractor's link and of the photographs it shows. */
const LINK_FAILURES: Readonly<Record<string, TranslationKey>> = {
  "issue-not-found": "issues.workOrders.errors.issueNotFound",
  "issue-closed": "issues.workOrders.link.errors.issueClosed",
  "work-order-ring-fenced": "issues.workOrders.errors.ringFenced",
  "work-order-links-off": "issues.workOrders.link.errors.linksOff",
  "work-order-not-found": "issues.workOrders.link.errors.workOrderNotFound",
  "work-order-answered": "issues.workOrders.link.errors.answered",
  "work-order-text-erased": "issues.workOrders.link.errors.textErased",
  "work-order-recipient-removed":
    "issues.workOrders.link.errors.recipientRemoved",
  "work-order-protected": "issues.workOrders.link.errors.protected",
  "work-order-photo-not-found": "issues.workOrders.link.errors.photoNotFound",
  "invalid-body": "issues.workOrders.link.errors.unknown",
};

/**
 * The link's refusals that mean the record on screen is out of date: each says
 * the work order or the issue is no longer as shown, so it is read again.
 */
const LINK_STALE_REASONS: ReadonlySet<string> = new Set([
  "issue-not-found",
  "issue-closed",
  "work-order-ring-fenced",
  "work-order-links-off",
  "work-order-not-found",
  "work-order-answered",
  "work-order-text-erased",
  "work-order-recipient-removed",
  "work-order-protected",
  "work-order-photo-not-found",
]);

/**
 * How long an issued link waits for the association's name, which only dresses
 * the message the handler sends with the address. The address is shown once
 * and cannot be shown again, so a read that stalls holds the address back at
 * most this long, and the address is then shown without the name. A refused
 * issuing does not wait for the name at all.
 */
const VIEWER_READ_MS = 5_000;

/** The viewer, or null when the read fails or is not answered in time. */
function boundedViewer(): Promise<Awaited<
  ReturnType<typeof fetchViewer>
> | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      resolve(null);
    }, VIEWER_READ_MS);
    fetchViewer().then(
      (viewer) => {
        clearTimeout(timer);
        resolve(viewer);
      },
      () => {
        clearTimeout(timer);
        resolve(null);
      },
    );
  });
}

const ANSWER_LABEL: Readonly<Record<WorkOrderAnswer, TranslationKey>> = {
  ACCEPTED: "issues.workOrders.answer.ACCEPTED",
  DECLINED: "issues.workOrders.answer.DECLINED",
  DONE: "issues.workOrders.answer.DONE",
};

/** A link just issued, shown this once and dropped when the record is read again. */
interface ShownLink {
  issueId: string;
  workOrderId: string;
  url: string;
  expiresAt: string;
  /** The association's name for the message, or null when it could not be read. */
  association: string | null;
}

/** The link act asked last, so its outcome is said beside its work order. */
interface LinkAct {
  kind: "issue" | "revoke";
  workOrderId: string;
}

/** A choice of photographs being saved, matched to its answer by `seq`. */
interface PhotoChoice {
  workOrderId: string;
  fileIds: readonly string[];
  seq: number;
}

function sameIds(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, index) => id === b[index]);
}

/**
 * How often the record is read again while a work order's mail is on its way.
 * The job usually settles within seconds; this is how soon the handler sees it.
 */
const PENDING_POLL_MS = 4000;

const DELIVERY_FAILURE_LABEL: Readonly<
  Record<WorkOrderDeliveryFailure, TranslationKey>
> = {
  "mail-not-configured": "issues.workOrders.failure.mailNotConfigured",
  "send-failed": "issues.workOrders.failure.sendFailed",
  "sending-interrupted": "issues.workOrders.failure.sendingInterrupted",
  "delivery-unconfirmed": "issues.workOrders.failure.deliveryUnconfirmed",
  "recipient-removed": "issues.workOrders.failure.recipientRemoved",
  "recipient-unreadable": "issues.workOrders.failure.recipientUnreadable",
  "text-erased": "issues.workOrders.failure.textErased",
  "ring-fenced": "issues.workOrders.failure.ringFenced",
};

/** A draft a preview was asked for, so its answer is matched to it. */
interface Draft {
  contractorId: string;
  body: string;
}

const EMPTY_DRAFT: Draft = { contractorId: "", body: "" };

function sameDraft(a: Draft, b: Draft): boolean {
  return a.contractorId === b.contractorId && a.body === b.body;
}

/**
 * The work orders on one issue (decision 23 of the issue module's plan): the
 * record of what was sent contractors, and a form to write another, previewed
 * before it is sent.
 *
 * What is sent is what was previewed. The send button is offered only beside a
 * preview, and it sends the draft that preview was made from; changing the
 * contractor or a word of the text drops the preview, and a preview answered
 * after the draft changed is dropped too, so the handler never sends a mail
 * they did not read.
 *
 * The API holds the sending to the same rule: it carries the preview's token,
 * and a contractor's address or text changed since the preview is refused, the
 * preview dropped and the record read again.
 *
 * Mounted only while a handler has it open, for the reason the handling panel
 * gives: it reads the contractors and the record of its own. While a work
 * order's mail is on its way the record is read again every few seconds, so
 * the handler sees it go out or fail without closing anything.
 *
 * A handler may remove the text of a work order in the record (ADR 0057), as
 * they remove the rest of an issue's free text; the work order stays, with
 * whom it went to and when. The record is read again after every answer, so a
 * text removed is not left standing on the screen.
 *
 * While the instance's switch for contractors' links is on (ADR 0055), each
 * work order offers a link of the contractor's own and a choice of the issue's
 * photographs it shows. The link's address is shown once, in the answer to
 * issuing it, and dropped the next time the record is read or when the handler
 * leaves: no read returns it again. Whatever the switch, what a contractor sent
 * through a link - the answer, notes and photographs - stays on the record,
 * each removable as the rest of the issue's free text is.
 */
export function IssueWorkOrders({
  issue,
  onSent,
  redaction,
}: {
  issue: QueuedIssue;
  /** Told after a work order is accepted, so the issue's timeline reads it. */
  onSent?: () => void;
  /** Offers the removal of a work order's text; none is offered without it. */
  redaction?: IssueRedactionControl;
}): ReactElement {
  const { t, i18n } = useTranslation();
  const [data, setData] = useState<IssueWorkOrdersData | null>(null);
  const [contractors, setContractors] = useState<ContractorChoice[] | null>(
    null,
  );
  const [ordersFailed, setOrdersFailed] = useState(false);
  const [choicesFailed, setChoicesFailed] = useState(false);
  const readFailed = ordersFailed || choicesFailed;
  /** Bumped after a send and after a refusal that says the screen is stale. */
  const [reads, setReads] = useState(0);
  /*
   * The reads an answer is matched to. Moved in the same step as `reads`, never
   * in a later effect: an answer asked before a removal and arriving in between
   * would otherwise pass as current and put the removed words back.
   */
  const readsRef = useRef(reads);
  /**
   * A link just issued. Shown only until the record is read again: the
   * address is never read back, so what stands on screen is this answer's.
   */
  const [shown, setShown] = useState<ShownLink | null>(null);
  const readAgain = (keepShown = false): void => {
    readsRef.current += 1;
    setReads(readsRef.current);
    // A choice of photographs saved after issuing keeps the address: the link
    // shows the photographs chosen when it is opened, so choosing them after
    // issuing is the order a handler may well work in.
    if (!keepShown) {
      setShown(null);
    }
  };

  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  /**
   * The latest draft, for answers that arrive after it changed. Written where
   * the draft is, in the handlers, so an answer is matched to what the handler
   * last typed.
   */
  const draftRef = useRef<Draft>(EMPTY_DRAFT);
  const [preview, setPreview] = useState<{
    draft: Draft;
    mail: WorkOrderPreview;
  } | null>(null);
  const [sentTo, setSentTo] = useState<string | null>(null);

  /*
   * The notice says the newest outcome. A removal refused after this screen's
   * last preview or send replaces that outcome's notice, and stays replaced
   * after the refusal is dismissed. Asking a preview or a send, the refusal of
   * either, an accepted send or a changed draft lets go of the removal's
   * refusal, here and beside the issue's own text.
   * A read that failed is said above a refusal: the refusal says the record was
   * read again, and it was not.
   */
  const redactionFailure = redaction?.failureKey ?? null;
  const dismissRedactionFailure = redaction?.dismissFailure;
  const [superseded, setSuperseded] = useState(false);
  // Set while rendering, from the refusal the last render saw, so the newer
  // refusal and the older notice are never shown in the same frame.
  const [seenRedactionFailure, setSeenRedactionFailure] =
    useState(redactionFailure);
  if (seenRedactionFailure !== redactionFailure) {
    setSeenRedactionFailure(redactionFailure);
    if (redactionFailure !== null) {
      setSuperseded(true);
    }
  }
  const ownOutcome = (): void => {
    setSuperseded(false);
    dismissRedactionFailure?.();
  };

  /*
   * A removal answered, or refused because the screen was stale: the record is
   * read again, and an answer to a read asked before it is dropped (`reads`).
   */
  const redactionRevision = redaction?.revision;
  const shownAtRedaction = useRef(redactionRevision);
  useEffect(() => {
    if (shownAtRedaction.current !== redactionRevision) {
      shownAtRedaction.current = redactionRevision;
      // The copy on screen goes with the removal, not with the read after it:
      // were that read to fail or be slow, the words just removed would stand
      // in the log beside the notice, as the conversation's lists are dropped.
      setData(null);
      // As `readAgain` does, written out here so the effect needs no function
      // made in render.
      readsRef.current += 1;
      setReads(readsRef.current);
      setShown(null);
    }
  }, [redactionRevision]);

  /*
   * The record and the contractors to choose from are read apart, so a slow or
   * failed list of contractors never holds back the log or its removal.
   */
  useEffect(() => {
    let active = true;
    void fetchIssueWorkOrders(issue.id).then((orders) => {
      if (active) {
        setData(orders.ok ? orders.value : null);
        setOrdersFailed(!orders.ok);
      }
    });
    void fetchContractorChoices().then((choices) => {
      if (active) {
        setContractors(choices.ok ? choices.value : null);
        setChoicesFailed(!choices.ok);
      }
    });
    return () => {
      active = false;
    };
  }, [issue.id, issue.meaning, reads]);

  const pending =
    data?.workOrders.some((order) => order.deliveryStatus === "PENDING") ??
    false;
  /*
   * The record alone, and only while something is on its way. Each answer is
   * matched to the reads it was asked under, so one that a send or a refusal
   * has since superseded is dropped; a failed attempt keeps what is shown, and
   * the next attempt asks again.
   */
  usePoll(
    async (stillWanted) => {
      const askedUnder = readsRef.current;
      const orders = await fetchIssueWorkOrders(issue.id);
      if (stillWanted() && orders.ok && askedUnder === readsRef.current) {
        setData(orders.value);
      }
    },
    { intervalMs: PENDING_POLL_MS, enabled: pending },
  );

  const onRefused = (failure: ApiFailure): void => {
    ownOutcome();
    if (STALE_REASONS.has(failure.reason)) {
      setPreview(null);
      readAgain();
    }
  };

  const previewing = useSaveAction(
    async (
      asked: Draft,
    ): Promise<ApiResult<{ draft: Draft; mail: WorkOrderPreview }>> => {
      const result = await previewWorkOrder({ issueId: issue.id, ...asked });
      return result.ok
        ? { ok: true, value: { draft: asked, mail: result.value } }
        : result;
    },
    (answered) => {
      // An answer for a draft the handler has since changed is not shown.
      if (sameDraft(answered.draft, draftRef.current)) {
        setPreview(answered);
      }
    },
    onRefused,
  );
  const sending = useSaveAction(
    (asked: { draft: Draft; previewToken: string }) =>
      sendWorkOrder({
        issueId: issue.id,
        ...asked.draft,
        previewToken: asked.previewToken,
      }),
    (sent) => {
      ownOutcome();
      setPreview(null);
      draftRef.current = EMPTY_DRAFT;
      setDraft(EMPTY_DRAFT);
      setSentTo(sent.recipientName);
      readAgain();
      onSent?.();
    },
    onRefused,
  );
  /*
   * A contractor's link: issued or withdrawn one at a time, its outcome said
   * beside the work order it was asked for. The association's name is read
   * beside the issuing, for the message the handler sends with the address.
   */
  const [linkAsked, setLinkAsked] = useState<LinkAct | null>(null);
  const linking = useSaveAction(
    async (
      act: LinkAct,
    ): Promise<
      ApiResult<{ act: LinkAct; shown: Omit<ShownLink, "issueId"> | null }>
    > => {
      const ref = { issueId: issue.id, workOrderId: act.workOrderId };
      if (act.kind === "revoke") {
        const revoked = await revokeWorkOrderLink(ref);
        return revoked.ok ? { ok: true, value: { act, shown: null } } : revoked;
      }
      // Read beside the issuing, and waited for only once the link is
      // issued: a refusal is shown as soon as it comes.
      const viewerRead = boundedViewer();
      const issued = await issueWorkOrderLink(ref);
      if (!issued.ok) {
        return issued;
      }
      const viewer = await viewerRead;
      return {
        ok: true,
        value: {
          act,
          shown: {
            workOrderId: act.workOrderId,
            url: issued.value.url,
            expiresAt: issued.value.expiresAt,
            association:
              viewer?.ok === true
                ? (viewer.value.housingCooperative?.name ?? null)
                : null,
          },
        },
      };
    },
    (done) => {
      ownOutcome();
      readAgain();
      if (done.shown !== null) {
        setShown({ ...done.shown, issueId: issue.id });
      }
    },
    (refused) => {
      ownOutcome();
      if (LINK_STALE_REASONS.has(refused.reason)) {
        readAgain();
      }
    },
  );
  const askLink = (act: LinkAct): void => {
    if (!linking.pending) {
      ownOutcome();
      setLinkAsked(act);
      void linking.submit(act);
    }
  };

  /*
   * The photographs a link shows. A choice the handler has changed and not
   * saved is held per work order; a save answered after a newer one was asked,
   * or after the choice changed again, leaves the newer choice standing.
   */
  const [photoDrafts, setPhotoDrafts] = useState<
    Readonly<Record<string, readonly string[]>>
  >({});
  const photoDraftsRef = useRef(photoDrafts);
  const photoSeq = useRef(0);
  const [photosAsked, setPhotosAsked] = useState<string | null>(null);
  const changePhotoDrafts = (
    next: Readonly<Record<string, readonly string[]>>,
  ): void => {
    photoDraftsRef.current = next;
    setPhotoDrafts(next);
  };
  const choosing = useSaveAction(
    async (choice: PhotoChoice): Promise<ApiResult<PhotoChoice>> => {
      const saved = await chooseWorkOrderPhotos({
        issueId: issue.id,
        workOrderId: choice.workOrderId,
        fileIds: choice.fileIds,
      });
      return saved.ok ? { ok: true, value: choice } : saved;
    },
    (saved) => {
      ownOutcome();
      if (saved.seq !== photoSeq.current) {
        return;
      }
      const draft = photoDraftsRef.current[saved.workOrderId];
      if (draft !== undefined && sameIds(draft, saved.fileIds)) {
        const rest = { ...photoDraftsRef.current };
        delete rest[saved.workOrderId];
        changePhotoDrafts(rest);
      }
      // What the API accepted, until the read after it answers.
      setData((current) =>
        current === null
          ? current
          : {
              ...current,
              workOrders: current.workOrders.map((order) =>
                order.id === saved.workOrderId
                  ? {
                      ...order,
                      contractorLink: {
                        ...order.contractorLink,
                        chosenFileIds: [...saved.fileIds],
                      },
                    }
                  : order,
              ),
            },
      );
      readAgain(true);
    },
    (refused) => {
      ownOutcome();
      if (LINK_STALE_REASONS.has(refused.reason)) {
        readAgain(true);
      }
    },
  );

  const busy = previewing.pending || sending.pending;
  const failure = superseded
    ? null
    : sending.state.kind === "failed"
      ? sending.state.failure
      : previewing.state.kind === "failed"
        ? previewing.state.failure
        : null;

  const changeDraft = (next: Draft): void => {
    ownOutcome();
    draftRef.current = next;
    setDraft(next);
    setPreview(null);
    setSentTo(null);
    previewing.reset();
    sending.reset();
  };

  // Listed with the switch off too, for the withdrawal of a link issued while
  // it was on: the switch holds it shut, but it would open again were the
  // switch turned on within its 30 days.
  const linkControl: ContractorLinkControl | null =
    data === null
      ? null
      : {
          enabled: data.linksEnabled,
          offered: data.linksEnabled && !data.ringFenced && !data.closed,
          protectedHousehold: data.protectedHousehold,
          choosable: data.choosablePhotos,
          shown: shown?.issueId === issue.id ? shown : null,
          busy: linking.pending,
          asked: superseded ? null : linkAsked,
          state: linking.state,
          ask: askLink,
          photos: {
            draftOf: (workOrderId) => photoDrafts[workOrderId],
            change: (workOrderId, fileIds) => {
              ownOutcome();
              // The notice was about the choice before; this one is unsaved.
              choosing.reset();
              changePhotoDrafts({
                ...photoDraftsRef.current,
                [workOrderId]: fileIds,
              });
            },
            save: (workOrderId, fileIds) => {
              if (!choosing.pending) {
                ownOutcome();
                photoSeq.current += 1;
                setPhotosAsked(workOrderId);
                void choosing.submit({
                  workOrderId,
                  fileIds,
                  seq: photoSeq.current,
                });
              }
            },
            busy: choosing.pending,
            asked: superseded ? null : photosAsked,
            state: choosing.state,
          },
        };

  const named = { type: issue.typeName };
  const chosen = contractors?.find(
    (contractor) => contractor.id === draft.contractorId,
  );
  const canPreview =
    !busy &&
    chosen !== undefined &&
    chosen.email !== null &&
    draft.body.trim() !== "";

  return (
    <div className="flex flex-col gap-4">
      {redactionFailure !== null && !readFailed ? (
        <Notice tone="danger" live>
          {t(redactionFailure)}
        </Notice>
      ) : failure !== null ? (
        <Notice tone="danger" live>
          {t(
            failureMessageKey(
              failure,
              WORK_ORDER_FAILURES,
              "issues.workOrders.errors.unknown",
            ),
          )}
        </Notice>
      ) : readFailed ? (
        <Notice tone="danger" live>
          {t("issues.workOrders.readFailed")}
        </Notice>
      ) : sentTo !== null && !superseded ? (
        <Notice tone="ok" live>
          {t("issues.workOrders.sent", { name: sentTo })}
        </Notice>
      ) : null}

      {data === null ? (
        readFailed ? null : (
          <p role="status" className={HINT}>
            {t("issues.workOrders.loading")}
          </p>
        )
      ) : (
        <WorkOrderLog
          orders={data.workOrders}
          locale={i18n.language}
          redaction={redaction}
          link={linkControl}
        />
      )}

      {data === null ? null : data.ringFenced ? (
        <p className={HINT}>{t("issues.workOrders.ringFenced")}</p>
      ) : data.closed ? (
        <p className={HINT}>{t("issues.workOrders.closed")}</p>
      ) : contractors === null ? null : contractors.length === 0 ? (
        <p className={HINT}>{t("issues.workOrders.noContractors")}</p>
      ) : (
        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (canPreview) {
              ownOutcome();
              void previewing.submit(draft);
            }
          }}
        >
          <h4 className="text-label text-ink-muted uppercase">
            {t("issues.workOrders.write")}
          </h4>
          <p className={HINT}>{t("issues.workOrders.writeHint")}</p>
          {issue.reporter.kind === "protected" ? (
            <Notice tone="warn">
              {t("issues.workOrders.protectedReporter")}
            </Notice>
          ) : null}

          <label className={`${LABEL} max-w-md`}>
            {t("issues.workOrders.contractor")}
            <select
              aria-label={t("issues.workOrders.contractorNamed", named)}
              value={draft.contractorId}
              disabled={busy}
              onChange={(event) => {
                changeDraft({ ...draft, contractorId: event.target.value });
              }}
              className={FIELD}
            >
              <option value="">
                {t("issues.workOrders.chooseContractor")}
              </option>
              {contractors.map((contractor) => (
                <option
                  key={contractor.id}
                  value={contractor.id}
                  disabled={contractor.email === null}
                >
                  {contractor.email === null
                    ? t("issues.workOrders.contractorWithoutEmail", {
                        name: contractor.name,
                        trade: contractor.trade,
                      })
                    : t("issues.workOrders.contractorOption", {
                        name: contractor.name,
                        trade: contractor.trade,
                      })}
                </option>
              ))}
            </select>
          </label>
          {chosen?.phone == null ? null : (
            <p className={HINT}>
              {t("issues.workOrders.phone")}{" "}
              <span className="font-data text-data text-ink">
                {chosen.phone}
              </span>
            </p>
          )}

          <label className={LABEL}>
            {t("issues.workOrders.body")}
            <textarea
              aria-label={t("issues.workOrders.bodyNamed", named)}
              value={draft.body}
              maxLength={WORK_ORDER_LIMITS.body}
              rows={6}
              disabled={busy}
              onChange={(event) => {
                changeDraft({ ...draft, body: event.target.value });
              }}
              className={FIELD_MULTILINE}
            />
          </label>

          {preview === null ? (
            <div>
              <button
                type="submit"
                disabled={!canPreview}
                className={SECONDARY_BUTTON}
              >
                {previewing.state.kind === "saving"
                  ? t("issues.workOrders.previewing")
                  : t("issues.workOrders.preview")}
              </button>
            </div>
          ) : (
            <PreviewPanel
              preview={preview.mail}
              sending={sending.state.kind === "saving"}
              disabled={busy}
              onSend={() => {
                ownOutcome();
                void sending.submit({
                  draft: preview.draft,
                  previewToken: preview.mail.previewToken,
                });
              }}
              onEdit={() => {
                setPreview(null);
              }}
            />
          )}
        </form>
      )}
    </div>
  );
}

/** The mail as the contractor will receive it, and the send beside it. */
function PreviewPanel({
  preview,
  sending,
  disabled,
  onSend,
  onEdit,
}: {
  preview: WorkOrderPreview;
  sending: boolean;
  disabled: boolean;
  onSend: () => void;
  onEdit: () => void;
}): ReactElement {
  const { t } = useTranslation();
  return (
    <section
      aria-label={t("issues.workOrders.previewTitle")}
      className="flex flex-col gap-3 rounded-control border border-line bg-page p-4"
    >
      <h5 className="text-label text-ink-muted uppercase">
        {t("issues.workOrders.previewTitle")}
      </h5>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-small">
        <dt className="text-ink-muted">{t("issues.workOrders.to")}</dt>
        <dd>
          {preview.recipient.name}{" "}
          <span className="font-data text-data">{preview.recipient.email}</span>
        </dd>
        <dt className="text-ink-muted">{t("issues.workOrders.subject")}</dt>
        <dd>{preview.subject}</dd>
      </dl>
      <p className="text-body whitespace-pre-wrap">{preview.text}</p>
      {preview.mailConfigured ? null : (
        <Notice tone="warn">{t("issues.workOrders.mailNotConfigured")}</Notice>
      )}
      <p className={HINT}>{t("issues.workOrders.previewHint")}</p>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          disabled={disabled}
          onClick={onSend}
          className={PRIMARY_BUTTON}
        >
          {sending
            ? t("issues.workOrders.sending")
            : t("issues.workOrders.send", { name: preview.recipient.name })}
        </button>
        <button
          type="button"
          disabled={disabled}
          onClick={onEdit}
          className={SECONDARY_BUTTON}
        >
          {t("issues.workOrders.edit")}
        </button>
      </div>
    </section>
  );
}

/** The record: whom each work order went to, when, what it said. */
function WorkOrderLog({
  orders,
  locale,
  redaction,
  link,
}: {
  orders: readonly WorkOrder[];
  locale: string;
  redaction: IssueRedactionControl | undefined;
  /** Null until the work orders are read. */
  link: ContractorLinkControl | null;
}): ReactElement {
  const { t } = useTranslation();
  if (orders.length === 0) {
    return <p className={HINT}>{t("issues.workOrders.none")}</p>;
  }
  return (
    <section className="flex flex-col gap-2">
      <h4 className="text-label text-ink-muted uppercase">
        {t("issues.workOrders.logTitle")}
      </h4>
      <ol className="flex flex-col gap-3">
        {orders.map((order) => (
          <li key={order.id} className="flex flex-col gap-1 text-small">
            <p className="flex flex-wrap gap-x-3">
              <span className="font-data text-data text-ink-muted">
                {formatMoment(order.sentAt, locale)}
              </span>
              {order.recipientName === null ? (
                <span className="text-ink-muted">
                  {t("issues.workOrders.recipientRemoved")}
                </span>
              ) : (
                <span>
                  {order.recipientName}{" "}
                  {order.recipientEmail === null ? (
                    <span className="text-ink-muted">
                      {t("issues.workOrders.addressUnreadable")}
                    </span>
                  ) : (
                    <span className="font-data text-data">
                      {order.recipientEmail}
                    </span>
                  )}
                </span>
              )}
              {order.sentBy === null ? null : (
                <span className="text-ink-muted">
                  {t("issues.workOrders.sentBy")}{" "}
                  <IssueHandlerName handler={order.sentBy} />
                </span>
              )}
            </p>
            <DeliveryLine order={order} />
            {order.redactedAt !== null ? (
              <p>
                <RedactedMark at={order.redactedAt} />
              </p>
            ) : order.body === null ? (
              <p className="text-ink-muted">
                {t("issues.workOrders.bodyErased")}
              </p>
            ) : (
              <>
                <details>
                  <summary className="flex min-h-11 cursor-pointer items-center">
                    {t("issues.workOrders.contents")}
                  </summary>
                  <p className="whitespace-pre-wrap">{order.body}</p>
                </details>
                {redaction === undefined ? null : (
                  <RedactAct
                    control={redaction}
                    redaction={{ target: "workOrder", id: order.id }}
                    label={
                      order.recipientName === null
                        ? t("issues.redaction.removeWorkOrder", {
                            at: formatMoment(order.sentAt, locale),
                          })
                        : t("issues.redaction.removeWorkOrderTo", {
                            name: order.recipientName,
                            at: formatMoment(order.sentAt, locale),
                          })
                    }
                  />
                )}
              </>
            )}
            <ContractorRecord
              order={order}
              locale={locale}
              redaction={redaction}
            />
            {link === null ? null : (
              <ContractorLinkPanel order={order} locale={locale} link={link} />
            )}
          </li>
        ))}
      </ol>
    </section>
  );
}

/** The link acts and the choice of photographs, as the log's rows use them. */
interface ContractorLinkControl {
  /**
   * The instance's switch. Off, a link issued while it was on is still listed
   * as live, to be withdrawn, and nothing else is offered.
   */
  enabled: boolean;
  /**
   * False with the switch off and on a ring-fenced or closed issue: only a
   * withdrawal is offered.
   */
  offered: boolean;
  /**
   * Somebody the issue concerns has protected personal data: no link is
   * given, and one given before is shown as ended.
   */
  protectedHousehold: boolean;
  choosable: readonly ChoosablePhoto[];
  shown: ShownLink | null;
  busy: boolean;
  /** The act whose outcome is said, or null once a newer outcome replaced it. */
  asked: LinkAct | null;
  state: SaveState;
  ask: (act: LinkAct) => void;
  photos: {
    draftOf: (workOrderId: string) => readonly string[] | undefined;
    change: (workOrderId: string, fileIds: readonly string[]) => void;
    save: (workOrderId: string, fileIds: readonly string[]) => void;
    busy: boolean;
    asked: string | null;
    state: SaveState;
  };
}

/** "the work order to Rörfirman of 3 Nov 2026, 10:00", for a control's name. */
function workOrderNamed(
  order: WorkOrder,
  locale: string,
): { name: string; at: string } | { at: string } {
  const at = formatMoment(order.sentAt, locale);
  return order.recipientName === null
    ? { at }
    : { name: order.recipientName, at };
}

/**
 * What the contractor sent through the work order's link: their answer, their
 * notes and their photographs. Shown whatever the switch, so what came in
 * while it was on stays on the record.
 */
function ContractorRecord({
  order,
  locale,
  redaction,
}: {
  order: WorkOrder;
  locale: string;
  redaction: IssueRedactionControl | undefined;
}): ReactElement | null {
  const { t } = useTranslation();
  const { answer, answeredAt, notes, files } = order.contractorLink;
  if (answer === null && notes.length === 0 && files.length === 0) {
    return null;
  }
  return (
    <div className="mt-1 flex flex-col gap-2 border-l-2 border-line pl-3">
      <h5 className="text-label text-ink-muted uppercase">
        {t("issues.workOrders.answer.title")}
      </h5>
      {answer === null ? null : (
        <p className="font-semibold">
          {answeredAt === null ? (
            t(ANSWER_LABEL[answer])
          ) : (
            <Trans
              i18nKey="issues.workOrders.answer.at"
              values={{
                answer: t(ANSWER_LABEL[answer]),
                date: formatMoment(answeredAt, locale),
              }}
              components={DATA_TAGS}
            />
          )}
        </p>
      )}
      {notes.length === 0 ? null : (
        <section className="flex flex-col gap-1">
          <h6 className="text-label text-ink-muted uppercase">
            {t("issues.workOrders.answer.notes")}
          </h6>
          <ol className="flex flex-col gap-2">
            {notes.map((note) => (
              <li key={note.id} className="flex flex-col gap-1">
                <span className="font-data text-data text-ink-muted">
                  {formatMoment(note.createdAt, locale)}
                </span>
                {note.redactedAt !== null ? (
                  <RedactedMark at={note.redactedAt} />
                ) : (
                  <>
                    <p className="whitespace-pre-wrap">{note.body}</p>
                    {redaction === undefined ? null : (
                      <RedactAct
                        control={redaction}
                        redaction={{ target: "workOrderNote", id: note.id }}
                        label={t("issues.redaction.removeWorkOrderNote", {
                          at: formatMoment(note.createdAt, locale),
                        })}
                      />
                    )}
                  </>
                )}
              </li>
            ))}
          </ol>
        </section>
      )}
      {files.length === 0 ? null : (
        <section className="flex flex-col gap-1">
          <h6 className="text-label text-ink-muted uppercase">
            {t("issues.workOrders.answer.files")}
          </h6>
          <ul className="flex flex-col gap-2">
            {files.map((file) => (
              <li key={file.id} className="flex flex-wrap items-center gap-3">
                <a
                  href={file.url}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex min-h-11 items-center gap-2 text-trust underline"
                >
                  <img
                    src={file.url}
                    alt={t("issues.workOrders.answer.fileAlt", {
                      name: file.fileName,
                    })}
                    className="size-12 rounded-control border border-line object-cover"
                  />
                  <span>{file.fileName}</span>
                </a>
                <span className="font-data text-data text-ink-muted">
                  {formatMoment(file.createdAt, locale)}
                </span>
                {redaction === undefined ? null : (
                  <RedactAct
                    control={redaction}
                    redaction={{ target: "workOrderFile", id: file.id }}
                    label={t("issues.redaction.removeWorkOrderFile", {
                      name: file.fileName,
                    })}
                  />
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

/**
 * The contractor's link to one work order: where it stands, issuing a new one
 * and withdrawing a live one, the address just issued, and the photographs it
 * shows. With the switch off, only a link still live, and only its withdrawal.
 */
function ContractorLinkPanel({
  order,
  locale,
  link,
}: {
  order: WorkOrder;
  locale: string;
  link: ContractorLinkControl;
}): ReactElement | null {
  const { t } = useTranslation();
  const record = order.contractorLink;
  const state = record.link.state;
  const asked = link.asked?.workOrderId === order.id ? link.asked : null;
  // With the switch off, a link is listed only while it is live, to be
  // withdrawn, and for as long as the withdrawal's outcome is said.
  if (
    (!link.offered && state === "none") ||
    (!link.enabled && state !== "live" && asked === null)
  ) {
    return null;
  }
  const named = workOrderNamed(order, locale);
  const answeredForGood =
    record.answer === "DECLINED" || record.answer === "DONE";
  const unavailable =
    order.body === null ||
    order.redactedAt !== null ||
    order.recipientName === null;
  const issuable =
    link.offered &&
    !answeredForGood &&
    !unavailable &&
    !link.protectedHousehold;
  // Not once the record says the link has ended (a photograph saved on an
  // issue that has since closed): the address would be shown as opening a
  // work order it no longer opens.
  const shown =
    link.shown?.workOrderId === order.id && state !== "ended"
      ? link.shown
      : null;
  const saving = asked !== null && link.state.kind === "saving";

  return (
    <section
      aria-label={t(
        "name" in named
          ? "issues.workOrders.link.titleNamed"
          : "issues.workOrders.link.titleUnnamed",
        named,
      )}
      className="mt-1 flex flex-col gap-2 border-l-2 border-line pl-3"
    >
      <h5 className="text-label text-ink-muted uppercase">
        {t("issues.workOrders.link.title")}
      </h5>
      <p>
        {!link.enabled && state === "live" && record.link.expiresAt !== null ? (
          <Trans
            i18nKey="issues.workOrders.link.switchedOff"
            values={{ date: formatMoment(record.link.expiresAt, locale) }}
            components={DATA_TAGS}
          />
        ) : state === "live" && record.link.expiresAt !== null ? (
          <Trans
            i18nKey="issues.workOrders.link.live"
            values={{ date: formatMoment(record.link.expiresAt, locale) }}
            components={DATA_TAGS}
          />
        ) : state === "none" ? (
          t("issues.workOrders.link.none")
        ) : state === "live" ? (
          t("issues.workOrders.link.liveUndated")
        ) : (
          t("issues.workOrders.link.ended")
        )}
      </p>

      {asked === null ? null : link.state.kind === "failed" ? (
        <Notice tone="danger" live>
          {t(
            failureMessageKey(
              link.state.failure,
              LINK_FAILURES,
              "issues.workOrders.link.errors.unknown",
            ),
          )}
        </Notice>
      ) : link.state.kind === "saved" && asked.kind === "revoke" ? (
        <Notice tone="ok" live>
          {t("issues.workOrders.link.revoked")}
        </Notice>
      ) : null}

      {shown === null ? null : <ShownLinkPanel shown={shown} locale={locale} />}

      {link.offered ? (
        answeredForGood ? (
          <p className={HINT}>{t("issues.workOrders.link.answered")}</p>
        ) : unavailable ? (
          <p className={HINT}>{t("issues.workOrders.link.unavailable")}</p>
        ) : link.protectedHousehold ? (
          <p className={HINT}>{t("issues.workOrders.link.protected")}</p>
        ) : (
          <p className={HINT}>{t("issues.workOrders.link.hint")}</p>
        )
      ) : null}

      {issuable || state === "live" ? (
        <div className="flex flex-wrap gap-2">
          {issuable ? (
            <button
              type="button"
              disabled={link.busy}
              aria-label={t(
                state === "live"
                  ? "issues.workOrders.link.reissueNamed"
                  : state === "ended"
                    ? "issues.workOrders.link.issueAgainNamed"
                    : "issues.workOrders.link.issueNamed",
                named,
              )}
              onClick={() => {
                link.ask({ kind: "issue", workOrderId: order.id });
              }}
              className={SECONDARY_BUTTON}
            >
              {saving && asked?.kind === "issue"
                ? t("issues.workOrders.link.issuing")
                : t(
                    state === "live"
                      ? "issues.workOrders.link.reissue"
                      : state === "ended"
                        ? "issues.workOrders.link.issueAgain"
                        : "issues.workOrders.link.issue",
                  )}
            </button>
          ) : null}
          {state === "live" ? (
            <button
              type="button"
              disabled={link.busy}
              aria-label={t(
                "name" in named
                  ? "issues.workOrders.link.revokeNamed"
                  : "issues.workOrders.link.revokeUnnamed",
                named,
              )}
              onClick={() => {
                link.ask({ kind: "revoke", workOrderId: order.id });
              }}
              className={SECONDARY_BUTTON}
            >
              {saving && asked?.kind === "revoke"
                ? t("issues.workOrders.link.revoking")
                : t("issues.workOrders.link.revoke")}
            </button>
          ) : null}
        </div>
      ) : null}

      {issuable ? (
        <PhotoChooser order={order} named={named} link={link} />
      ) : null}
    </section>
  );
}

/**
 * The address just issued, said once: in a field to copy from, with a short
 * message that carries nothing of the work order, the issue or its reporter.
 * The handler sends it the way they choose; the instance sends nothing.
 */
function ShownLinkPanel({
  shown,
  locale,
}: {
  shown: ShownLink;
  locale: string;
}): ReactElement {
  const { t } = useTranslation();
  const [copied, setCopied] = useState<"copied" | "failed" | null>(null);
  const message =
    shown.association === null
      ? t("issues.workOrders.link.shown.messageTextUnnamed", { url: shown.url })
      : t("issues.workOrders.link.shown.messageText", {
          url: shown.url,
          association: shown.association,
        });
  const copy = (text: string): void => {
    void copyText(text).then((ok) => {
      setCopied(ok ? "copied" : "failed");
    });
  };
  return (
    <div className="flex flex-col gap-3 rounded-control border border-line bg-page p-4">
      <Notice tone="warn">{t("issues.workOrders.link.shown.once")}</Notice>
      <p className={HINT}>
        <Trans
          i18nKey="issues.workOrders.link.shown.expires"
          values={{ date: formatMoment(shown.expiresAt, locale) }}
          components={DATA_TAGS}
        />
      </p>
      <label className={LABEL}>
        {t("issues.workOrders.link.shown.url")}
        <input
          type="text"
          readOnly
          value={shown.url}
          onFocus={(event) => {
            event.target.select();
          }}
          className={FIELD_DATA}
        />
      </label>
      <label className={LABEL}>
        {t("issues.workOrders.link.shown.message")}
        <textarea
          readOnly
          value={message}
          rows={3}
          onFocus={(event) => {
            event.target.select();
          }}
          className={FIELD_MULTILINE}
        />
      </label>
      <p className={HINT}>{t("issues.workOrders.link.shown.send")}</p>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => {
            copy(shown.url);
          }}
          className={SECONDARY_BUTTON}
        >
          {t("issues.workOrders.link.shown.copyUrl")}
        </button>
        <button
          type="button"
          onClick={() => {
            copy(message);
          }}
          className={SECONDARY_BUTTON}
        >
          {t("issues.workOrders.link.shown.copyMessage")}
        </button>
      </div>
      {copied === "copied" ? (
        <Notice tone="ok" live>
          {t("issues.workOrders.link.shown.copied")}
        </Notice>
      ) : copied === "failed" ? (
        <Notice tone="danger" live>
          {t("issues.workOrders.link.shown.copyFailed")}
        </Notice>
      ) : null}
    </div>
  );
}

/**
 * Which of the issue's photographs the link shows, chosen and then saved as a
 * whole. A photograph no longer on the issue is left out of what is saved.
 */
function PhotoChooser({
  order,
  named,
  link,
}: {
  order: WorkOrder;
  named: { name: string; at: string } | { at: string };
  link: ContractorLinkControl;
}): ReactElement {
  const { t } = useTranslation();
  const photos = link.photos;
  const saved = order.contractorLink.chosenFileIds;
  const draft = photos.draftOf(order.id);
  const chosen = new Set(draft ?? saved);
  const choice = link.choosable
    .map((photo) => photo.fileId)
    .filter((fileId) => chosen.has(fileId));
  const asked = photos.asked === order.id;
  const changed = draft !== undefined && !sameIds(choice, saved);

  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="text-label text-ink-muted uppercase">
        {t("issues.workOrders.link.photos.title")}
      </legend>
      {link.choosable.length === 0 ? (
        <p className={HINT}>{t("issues.workOrders.link.photos.none")}</p>
      ) : (
        <>
          <p className={HINT}>{t("issues.workOrders.link.photos.hint")}</p>
          <ul className="flex flex-wrap gap-3">
            {link.choosable.map((photo) => (
              <li key={photo.fileId}>
                <label className="flex min-h-11 cursor-pointer items-center gap-2 text-small">
                  <input
                    type="checkbox"
                    checked={chosen.has(photo.fileId)}
                    onChange={(event) => {
                      const next = event.target.checked
                        ? [...choice, photo.fileId]
                        : choice.filter((fileId) => fileId !== photo.fileId);
                      photos.change(
                        order.id,
                        link.choosable
                          .map((each) => each.fileId)
                          .filter((fileId) => next.includes(fileId)),
                      );
                    }}
                    className="size-5"
                  />
                  <img
                    src={photo.url}
                    alt={photo.fileName}
                    className="size-12 rounded-control border border-line object-cover"
                  />
                  <span className="text-ink-muted">
                    {t(
                      photo.source === "report"
                        ? "issues.workOrders.link.photos.fromReport"
                        : "issues.workOrders.link.photos.fromHandler",
                    )}
                  </span>
                </label>
              </li>
            ))}
          </ul>
          <div>
            <button
              type="button"
              disabled={photos.busy || !changed}
              aria-label={t(
                "name" in named
                  ? "issues.workOrders.link.photos.saveNamed"
                  : "issues.workOrders.link.photos.saveUnnamed",
                named,
              )}
              onClick={() => {
                photos.save(order.id, choice);
              }}
              className={SECONDARY_BUTTON}
            >
              {asked && photos.state.kind === "saving"
                ? t("issues.workOrders.link.photos.saving")
                : t("issues.workOrders.link.photos.save")}
            </button>
          </div>
          {!asked ? null : photos.state.kind === "failed" ? (
            <Notice tone="danger" live>
              {t(
                failureMessageKey(
                  photos.state.failure,
                  LINK_FAILURES,
                  "issues.workOrders.link.errors.photosUnknown",
                ),
              )}
            </Notice>
          ) : photos.state.kind === "saved" ? (
            <Notice tone="ok" live>
              {t("issues.workOrders.link.photos.saved")}
            </Notice>
          ) : null}
        </>
      )}
    </fieldset>
  );
}

/**
 * Whether the mail went out, said in words and never by colour alone. Each
 * failure says what is known: "not sent" only where nothing left, and
 * "unconfirmed" where the mail may have gone out, so a handler is not invited
 * to send the contractor the same job twice.
 */
function DeliveryLine({ order }: { order: WorkOrder }): ReactElement {
  const { t } = useTranslation();
  switch (order.deliveryStatus) {
    case "PENDING":
      return (
        <span className="text-ink-muted">{t("issues.workOrders.pending")}</span>
      );
    case "SENT":
      return <span>{t("issues.workOrders.delivered")}</span>;
    case "FAILED":
      return (
        <span className="font-semibold text-danger">
          {t(
            order.deliveryFailure === null
              ? "issues.workOrders.failed"
              : DELIVERY_FAILURE_LABEL[order.deliveryFailure],
          )}
        </span>
      );
  }
}

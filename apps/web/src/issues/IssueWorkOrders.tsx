import { WORK_ORDER_LIMITS } from "@openbrf/shared";
import { useEffect, useRef, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";

import type { ApiFailure, ApiResult } from "../api/client";
import type { QueuedIssue } from "../api/issues";
import {
  type ContractorChoice,
  fetchContractorChoices,
  fetchIssueWorkOrders,
  type IssueWorkOrders as IssueWorkOrdersData,
  previewWorkOrder,
  sendWorkOrder,
  type WorkOrder,
  type WorkOrderDeliveryFailure,
  type WorkOrderPreview,
} from "../api/work-orders";
import type { TranslationKey } from "../i18n/translation-key";
import {
  FIELD,
  FIELD_MULTILINE,
  HINT,
  LABEL,
  PRIMARY_BUTTON,
  SECONDARY_BUTTON,
} from "../ui/controls";
import { formatMoment } from "../ui/moment";
import { Notice } from "../ui/Notice";
import { failureMessageKey, useSaveAction } from "../ui/save-state";
import { IssueHandlerName } from "./IssueHandlerName";

const WORK_ORDER_FAILURES: Readonly<Record<string, TranslationKey>> = {
  "issue-not-found": "issues.workOrders.errors.issueNotFound",
  "contractor-not-found": "issues.workOrders.errors.contractorNotFound",
  "contractor-without-email": "issues.workOrders.errors.contractorWithoutEmail",
  "work-order-ring-fenced": "issues.workOrders.errors.ringFenced",
  "work-order-identity-number": "issues.workOrders.errors.identityNumber",
  "work-order-empty": "issues.workOrders.errors.empty",
  "invalid-body": "issues.workOrders.errors.unknown",
};

/** The refusals that mean what the screen shows is out of date. */
const STALE_REASONS: ReadonlySet<string> = new Set([
  "issue-not-found",
  "contractor-not-found",
  "contractor-without-email",
  "work-order-ring-fenced",
]);

const DELIVERY_FAILURE_LABEL: Readonly<
  Record<WorkOrderDeliveryFailure, TranslationKey>
> = {
  "mail-not-configured": "issues.workOrders.failure.mailNotConfigured",
  "send-failed": "issues.workOrders.failure.sendFailed",
  "sending-interrupted": "issues.workOrders.failure.sendingInterrupted",
  "delivery-unconfirmed": "issues.workOrders.failure.deliveryUnconfirmed",
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
 * Mounted only while a handler has it open, for the reason the handling panel
 * gives: it reads the contractors and the record of its own.
 */
export function IssueWorkOrders({
  issue,
}: {
  issue: QueuedIssue;
}): ReactElement {
  const { t, i18n } = useTranslation();
  const [data, setData] = useState<IssueWorkOrdersData | null>(null);
  const [contractors, setContractors] = useState<ContractorChoice[] | null>(
    null,
  );
  const [readFailed, setReadFailed] = useState(false);
  /** Bumped after a send and after a refusal that says the screen is stale. */
  const [reads, setReads] = useState(0);

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

  useEffect(() => {
    let active = true;
    void Promise.all([
      fetchIssueWorkOrders(issue.id),
      fetchContractorChoices(),
    ]).then(([orders, choices]) => {
      if (!active) {
        return;
      }
      setData(orders.ok ? orders.value : null);
      setContractors(choices.ok ? choices.value : null);
      setReadFailed(!orders.ok || !choices.ok);
    });
    return () => {
      active = false;
    };
  }, [issue.id, reads]);

  const onRefused = (failure: ApiFailure): void => {
    if (STALE_REASONS.has(failure.reason)) {
      setPreview(null);
      setReads((count) => count + 1);
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
    (asked: Draft) => sendWorkOrder({ issueId: issue.id, ...asked }),
    (sent) => {
      setPreview(null);
      draftRef.current = EMPTY_DRAFT;
      setDraft(EMPTY_DRAFT);
      setSentTo(sent.recipientName);
      setReads((count) => count + 1);
    },
    onRefused,
  );
  const busy = previewing.pending || sending.pending;
  const failure =
    sending.state.kind === "failed"
      ? sending.state.failure
      : previewing.state.kind === "failed"
        ? previewing.state.failure
        : null;

  const changeDraft = (next: Draft): void => {
    draftRef.current = next;
    setDraft(next);
    setPreview(null);
    setSentTo(null);
    previewing.reset();
    sending.reset();
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
      {failure !== null ? (
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
      ) : sentTo !== null ? (
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
        <WorkOrderLog orders={data.workOrders} locale={i18n.language} />
      )}

      {data === null ? null : data.ringFenced ? (
        <p className={HINT}>{t("issues.workOrders.ringFenced")}</p>
      ) : contractors === null ? null : contractors.length === 0 ? (
        <p className={HINT}>{t("issues.workOrders.noContractors")}</p>
      ) : (
        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (canPreview) {
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
                void sending.submit(preview.draft);
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
}: {
  orders: readonly WorkOrder[];
  locale: string;
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
              <span>
                {order.recipientName}{" "}
                <span className="font-data text-data">
                  {order.recipientEmail}
                </span>
              </span>
              {order.sentBy === null ? null : (
                <span className="text-ink-muted">
                  {t("issues.workOrders.sentBy")}{" "}
                  <IssueHandlerName handler={order.sentBy} />
                </span>
              )}
            </p>
            <DeliveryLine order={order} />
            <details>
              <summary className="flex min-h-11 cursor-pointer items-center">
                {t("issues.workOrders.contents")}
              </summary>
              <p className="whitespace-pre-wrap">{order.body}</p>
            </details>
          </li>
        ))}
      </ol>
    </section>
  );
}

/** Whether the mail went out, said in words and never by colour alone. */
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
          {t("issues.workOrders.failed")}{" "}
          {order.deliveryFailure === null
            ? null
            : t(DELIVERY_FAILURE_LABEL[order.deliveryFailure])}
        </span>
      );
  }
}
